import type { AuthError, AuthChangeEvent, Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";

export type Priority = "alta" | "media" | "baja";
export const PRIORITIES: Priority[] = ["alta", "media", "baja"];
export const PRIORITY_LABELS: Record<Priority, string> = { alta: "Alta", media: "Media", baja: "Baja" };

export type Initiative = { id: string; name: string; color: string };
export type Task = {
  id: string;
  text: string;
  initiativeId: string | null;
  meetingId: string | null;
  createdAt: string;
  imagePath: string | null;
  /** Temporary signed URL used to display the private image. */
  image?: string;
};
export type Meeting = { id: string; title: string; priority: Priority; createdAt: string; tasks: Task[] };
export type Workspace = { initiatives: Initiative[]; currentTasks: Task[]; meetings: Meeting[]; reminderMinutes: number };
export type AccountUser = { id: string; email: string };
export type AuthState =
  | { status: "out" }
  | { status: "in"; user: AccountUser }
  | { status: "recovery" };

const BUCKET = "task-images";
const SIGNED_URL_SECONDS = 60 * 60 * 12;
const DEFAULT_REMINDER_MINUTES = 30;
const TASK_COLUMNS = "id, text, initiative_id, meeting_id, image_path, created_at";
const MEETING_COLUMNS = "id, title, priority, created_at";
const DEFAULT_INITIATIVES = [
  { name: "Producto", color: "#D97757" },
  { name: "Marketing", color: "#5F8F82" },
  { name: "Operaciones", color: "#B9913F" },
];

type TaskRow = { id: string; text: string; initiative_id: string | null; meeting_id: string | null; image_path: string | null; created_at: string };

let workspaceLoad: { userId: string; promise: Promise<Workspace> } | null = null;

function db() {
  if (!supabase) throw new Error("Supabase no está configurado.");
  return supabase;
}

function fail(error: { message: string } | null, action: string): asserts error is null {
  if (error) throw new Error(`${action}: ${error.message}`);
}

function toTask(row: TaskRow): Task {
  return { id: row.id, text: row.text, initiativeId: row.initiative_id, meetingId: row.meeting_id, createdAt: row.created_at, imagePath: row.image_path };
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

const AUTH_MESSAGES: Record<string, string> = {
  invalid_credentials: "El email o la contraseña no son correctos.",
  email_not_confirmed: "Todavía no confirmaste tu email. Revisá tu casilla y abrí el link que te enviamos.",
  user_already_exists: "Ya existe una cuenta con ese email. Ingresá con tu contraseña.",
  email_exists: "Ya existe una cuenta con ese email. Ingresá con tu contraseña.",
  weak_password: "La contraseña es muy débil. Usá al menos 6 caracteres.",
  same_password: "La contraseña nueva tiene que ser distinta a la anterior.",
  email_address_invalid: "Ese email no es válido.",
  over_email_send_rate_limit: "Se enviaron demasiados emails. Esperá unos minutos y volvé a intentar.",
  over_request_rate_limit: "Demasiados intentos. Esperá unos minutos y volvé a intentar.",
  signup_disabled: "El registro de cuentas nuevas está desactivado.",
};

function authFail(error: AuthError | null): asserts error is null {
  if (error) throw new Error((error.code && AUTH_MESSAGES[error.code]) || error.message);
}

function toAuthState(event: AuthChangeEvent, session: Session | null): AuthState {
  if (event === "PASSWORD_RECOVERY") return { status: "recovery" };
  const user = session?.user;
  // Sessions from the old anonymous mode do not count as signed in.
  if (!user || user.is_anonymous || !user.email) return { status: "out" };
  return { status: "in", user: { id: user.id, email: user.email } };
}

/** Calls back with the auth state now and on every change. Returns the unsubscribe function. */
export function watchAuth(callback: (state: AuthState, event: AuthChangeEvent) => void): () => void {
  const { data } = db().auth.onAuthStateChange((event, session) => callback(toAuthState(event, session), event));
  return () => data.subscription.unsubscribe();
}

export async function signIn(email: string, password: string) {
  const { error } = await db().auth.signInWithPassword({ email, password });
  authFail(error);
}

/** Creates the account. Returns true when Supabase asks to confirm the email first. */
export async function signUp(email: string, password: string): Promise<boolean> {
  const { data, error } = await db().auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } });
  authFail(error);
  // With email confirmation on, an existing email comes back as a user without identities.
  if (data.user && data.user.identities?.length === 0) throw new Error(AUTH_MESSAGES.user_already_exists);
  return !data.session;
}

export async function sendPasswordReset(email: string) {
  const { error } = await db().auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
  authFail(error);
}

export async function updatePassword(password: string) {
  const { error } = await db().auth.updateUser({ password });
  authFail(error);
}

export async function signOut() {
  workspaceLoad = null;
  const { error } = await db().auth.signOut();
  authFail(error);
}

async function currentUserId(): Promise<string> {
  const { data } = await db().auth.getSession();
  const user = data.session?.user;
  if (!user || user.is_anonymous) throw new Error("Tu sesión terminó. Volvé a ingresar.");
  return user.id;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

async function withSignedUrls(tasks: Task[]): Promise<Task[]> {
  const paths = tasks.flatMap((task) => (task.imagePath ? [task.imagePath] : []));
  if (paths.length === 0) return tasks;
  const { data, error } = await db().storage.from(BUCKET).createSignedUrls(paths, SIGNED_URL_SECONDS);
  fail(error, "No se pudieron cargar las imágenes");
  const urls = new Map(data.map((item) => [item.path, item.signedUrl]));
  return tasks.map((task) => (task.imagePath ? { ...task, image: urls.get(task.imagePath) ?? undefined } : task));
}

async function uploadImage(image: Blob): Promise<string> {
  const uid = await currentUserId();
  const extension = image.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
  const path = `${uid}/${crypto.randomUUID()}.${extension}`;
  const { error } = await db().storage.from(BUCKET).upload(path, image, { contentType: image.type || "image/png" });
  fail(error, "No se pudo subir la imagen");
  return path;
}

async function removeImages(paths: (string | null)[]) {
  const existing = paths.filter((path): path is string => Boolean(path));
  if (existing.length === 0) return;
  // Orphaned files are harmless, so a failed cleanup does not interrupt the user.
  const { error } = await db().storage.from(BUCKET).remove(existing);
  if (error) console.warn("No se pudieron borrar imágenes:", error.message);
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

async function fetchWorkspace(): Promise<Workspace> {
  const client = db();

  const initiativesResult = await client.from("initiatives").select("id, name, color").order("created_at");
  fail(initiativesResult.error, "No se pudieron cargar las iniciativas");
  let initiatives: Initiative[] = initiativesResult.data;
  if (initiatives.length === 0) {
    const seeded = await client.from("initiatives").insert(DEFAULT_INITIATIVES).select("id, name, color");
    fail(seeded.error, "No se pudieron crear las iniciativas iniciales");
    initiatives = seeded.data;
  }

  const [meetingsResult, tasksResult, settingsResult] = await Promise.all([
    client.from("meetings").select(MEETING_COLUMNS).order("created_at", { ascending: false }),
    client.from("tasks").select(TASK_COLUMNS).order("created_at", { ascending: false }),
    client.from("user_settings").select("reminder_minutes").maybeSingle(),
  ]);
  fail(meetingsResult.error, "No se pudieron cargar las reuniones");
  fail(tasksResult.error, "No se pudieron cargar las tareas");
  fail(settingsResult.error, "No se pudo cargar la configuración");

  const tasks = await withSignedUrls((tasksResult.data as TaskRow[]).map(toTask));
  return {
    initiatives,
    reminderMinutes: settingsResult.data?.reminder_minutes ?? DEFAULT_REMINDER_MINUTES,
    currentTasks: tasks.filter((task) => task.meetingId === null),
    meetings: meetingsResult.data.map((meeting) => ({
      id: meeting.id,
      title: meeting.title,
      priority: meeting.priority as Priority,
      createdAt: meeting.created_at,
      tasks: tasks.filter((task) => task.meetingId === meeting.id),
    })),
  };
}

/** Loads everything for the signed-in user. Deduplicated so a double mount does not seed twice. */
export function loadWorkspace(userId: string): Promise<Workspace> {
  if (workspaceLoad?.userId !== userId) {
    const promise = fetchWorkspace().catch((error) => {
      if (workspaceLoad?.promise === promise) workspaceLoad = null;
      throw error;
    });
    workspaceLoad = { userId, promise };
  }
  return workspaceLoad.promise;
}

export async function setReminderMinutes(minutes: number) {
  const uid = await currentUserId();
  const { error } = await db().from("user_settings").upsert({ user_id: uid, reminder_minutes: minutes, updated_at: new Date().toISOString() });
  fail(error, "No se pudo guardar el intervalo");
}

// ---------------------------------------------------------------------------
// Initiatives
// ---------------------------------------------------------------------------

export async function createInitiative(name: string, color: string): Promise<Initiative> {
  const { data, error } = await db().from("initiatives").insert({ name, color }).select("id, name, color").single();
  fail(error, "No se pudo crear la iniciativa");
  return data;
}

export async function renameInitiative(id: string, name: string) {
  const { error } = await db().from("initiatives").update({ name }).eq("id", id);
  fail(error, "No se pudo renombrar la iniciativa");
}

/** Deletes the initiative and its pending tasks. Tasks in saved meetings stay, without initiative. */
export async function deleteInitiative(id: string) {
  const client = db();
  const pending = await client.from("tasks").delete().eq("initiative_id", id).is("meeting_id", null).select("image_path");
  fail(pending.error, "No se pudieron borrar las tareas de la iniciativa");
  const { error } = await client.from("initiatives").delete().eq("id", id);
  fail(error, "No se pudo borrar la iniciativa");
  await removeImages(pending.data.map((row) => row.image_path));
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export async function addTask(text: string, initiativeId: string, image?: Blob): Promise<Task> {
  const imagePath = image ? await uploadImage(image) : null;
  const { data, error } = await db().from("tasks").insert({ text, initiative_id: initiativeId, image_path: imagePath }).select(TASK_COLUMNS).single();
  if (error) {
    await removeImages([imagePath]);
    fail(error, "No se pudo guardar la tarea");
  }
  const [task] = await withSignedUrls([toTask(data as TaskRow)]);
  return task;
}

export async function updateTaskText(id: string, text: string) {
  const { error } = await db().from("tasks").update({ text }).eq("id", id);
  fail(error, "No se pudo editar la tarea");
}

export async function deleteTask(task: Task) {
  const { error } = await db().from("tasks").delete().eq("id", task.id);
  fail(error, "No se pudo borrar la tarea");
  await removeImages([task.imagePath]);
}

/** Replaces the task's image (for example after highlighting) and returns the updated task. */
export async function replaceTaskImage(task: Task, image: Blob): Promise<Task> {
  const imagePath = await uploadImage(image);
  const { error } = await db().from("tasks").update({ image_path: imagePath }).eq("id", task.id);
  if (error) {
    await removeImages([imagePath]);
    fail(error, "No se pudo guardar el resaltado");
  }
  await removeImages([task.imagePath]);
  const [updated] = await withSignedUrls([{ ...task, imagePath, image: undefined }]);
  return updated;
}

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------

/** Moves every pending task into a new saved meeting and returns its id. */
export async function saveMeeting(title: string, priority: Priority): Promise<{ id: string; createdAt: string }> {
  const client = db();
  const { data: id, error } = await client.rpc("save_meeting", { p_title: title, p_priority: priority });
  fail(error, "No se pudo guardar la reunión");
  const meeting = await client.from("meetings").select("created_at").eq("id", id).single();
  fail(meeting.error, "No se pudo leer la reunión guardada");
  return { id: id as string, createdAt: meeting.data.created_at };
}

export async function renameMeeting(id: string, title: string) {
  const { error } = await db().from("meetings").update({ title }).eq("id", id);
  fail(error, "No se pudo renombrar la reunión");
}

export async function setMeetingPriority(id: string, priority: Priority) {
  const { error } = await db().from("meetings").update({ priority }).eq("id", id);
  fail(error, "No se pudo cambiar la prioridad");
}

/** Deletes the meeting, its tasks (by cascade) and their images. */
export async function deleteMeeting(meeting: Meeting) {
  const { error } = await db().from("meetings").delete().eq("id", meeting.id);
  fail(error, "No se pudo borrar la reunión");
  await removeImages(meeting.tasks.map((task) => task.imagePath));
}
