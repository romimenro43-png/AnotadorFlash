import { supabase } from "./supabase";

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
export type Meeting = { id: string; title: string; createdAt: string; tasks: Task[] };
export type Workspace = { initiatives: Initiative[]; currentTasks: Task[]; meetings: Meeting[] };

const BUCKET = "task-images";
const SIGNED_URL_SECONDS = 60 * 60 * 12;
const TASK_COLUMNS = "id, text, initiative_id, meeting_id, image_path, created_at";
const DEFAULT_INITIATIVES = [
  { name: "Producto", color: "#D97757" },
  { name: "Marketing", color: "#5F8F82" },
  { name: "Operaciones", color: "#B9913F" },
];

type TaskRow = { id: string; text: string; initiative_id: string | null; meeting_id: string | null; image_path: string | null; created_at: string };

let userId: string | null = null;
let workspaceLoad: Promise<Workspace> | null = null;

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

async function ensureSession(): Promise<string> {
  if (userId) return userId;
  const client = db();
  const { data } = await client.auth.getSession();
  if (data.session) return (userId = data.session.user.id);
  const { data: signIn, error } = await client.auth.signInAnonymously();
  fail(error, "No se pudo iniciar sesión");
  if (!signIn.user) throw new Error("No se pudo iniciar sesión.");
  return (userId = signIn.user.id);
}

async function withSignedUrls(tasks: Task[]): Promise<Task[]> {
  const paths = tasks.flatMap((task) => (task.imagePath ? [task.imagePath] : []));
  if (paths.length === 0) return tasks;
  const { data, error } = await db().storage.from(BUCKET).createSignedUrls(paths, SIGNED_URL_SECONDS);
  fail(error, "No se pudieron cargar las imágenes");
  const urls = new Map(data.map((item) => [item.path, item.signedUrl]));
  return tasks.map((task) => (task.imagePath ? { ...task, image: urls.get(task.imagePath) ?? undefined } : task));
}

async function uploadImage(image: Blob): Promise<string> {
  const uid = await ensureSession();
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

async function fetchWorkspace(): Promise<Workspace> {
  await ensureSession();
  const client = db();

  const initiativesResult = await client.from("initiatives").select("id, name, color").order("created_at");
  fail(initiativesResult.error, "No se pudieron cargar las iniciativas");
  let initiatives: Initiative[] = initiativesResult.data;
  if (initiatives.length === 0) {
    const seeded = await client.from("initiatives").insert(DEFAULT_INITIATIVES).select("id, name, color");
    fail(seeded.error, "No se pudieron crear las iniciativas iniciales");
    initiatives = seeded.data;
  }

  const [meetingsResult, tasksResult] = await Promise.all([
    client.from("meetings").select("id, title, created_at").order("created_at", { ascending: false }),
    client.from("tasks").select(TASK_COLUMNS).order("created_at", { ascending: false }),
  ]);
  fail(meetingsResult.error, "No se pudieron cargar las reuniones");
  fail(tasksResult.error, "No se pudieron cargar las tareas");

  const tasks = await withSignedUrls((tasksResult.data as TaskRow[]).map(toTask));
  return {
    initiatives,
    currentTasks: tasks.filter((task) => task.meetingId === null),
    meetings: meetingsResult.data.map((meeting) => ({
      id: meeting.id,
      title: meeting.title,
      createdAt: meeting.created_at,
      tasks: tasks.filter((task) => task.meetingId === meeting.id),
    })),
  };
}

/** Signs in (anonymously on first visit) and loads everything. Deduplicated so a double mount does not seed twice. */
export function loadWorkspace(): Promise<Workspace> {
  workspaceLoad ??= fetchWorkspace().catch((error) => {
    workspaceLoad = null;
    throw error;
  });
  return workspaceLoad;
}

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

/** Moves every pending task into a new saved meeting and returns its id. */
export async function saveMeeting(title: string): Promise<{ id: string; createdAt: string }> {
  const client = db();
  const { data: id, error } = await client.rpc("save_meeting", { p_title: title });
  fail(error, "No se pudo guardar la reunión");
  const meeting = await client.from("meetings").select("created_at").eq("id", id).single();
  fail(meeting.error, "No se pudo leer la reunión guardada");
  return { id: id as string, createdAt: meeting.data.created_at };
}

export async function renameMeeting(id: string, title: string) {
  const { error } = await db().from("meetings").update({ title }).eq("id", id);
  fail(error, "No se pudo renombrar la reunión");
}

/** Deletes the meeting, its tasks (by cascade) and their images. */
export async function deleteMeeting(meeting: Meeting) {
  const { error } = await db().from("meetings").delete().eq("id", meeting.id);
  fail(error, "No se pudo borrar la reunión");
  await removeImages(meeting.tasks.map((task) => task.imagePath));
}
