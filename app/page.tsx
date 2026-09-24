"use client";

import { ChangeEvent, ClipboardEvent, FormEvent, PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../lib/data";
import { PRIORITIES, PRIORITY_LABELS } from "../lib/data";
import type { AccountUser, AuthState, Initiative, Meeting, Priority, Task } from "../lib/data";
import { isSupabaseConfigured } from "../lib/supabase";

type IconName = "plus" | "trash" | "paperclip" | "clock" | "x" | "bell" | "archive" | "edit";
type PendingImage = { file: Blob; preview: string };

const colors = ["#D97757", "#5F8F82", "#B9913F", "#8B6F9E", "#4B7A9B", "#A96F52"];
const highlightColors = ["#FFE14D", "#7CE0A3", "#FF8FB1", "#7DC8FF"];
const reminderOptions = [5, 10, 15, 20, 30, 45, 60, 90, 120];
const priorityRank: Record<Priority, number> = { alta: 0, media: 1, baja: 2 };

const formatTime = (iso: string) => new Date(iso).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
const formatDay = (iso: string) => new Date(iso).toLocaleDateString("es-AR", { day: "numeric", month: "short" });
const messageOf = (error: unknown) => (error instanceof Error ? error.message : "Ocurrió un error inesperado.");
const pad = (value: number) => String(value).padStart(2, "0");
/** 3725000 ms -> "01:02:05" */
function formatClock(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
}
/** Countdown: "12:05", or "1:12:05" when it is an hour or more. */
function formatCountdown(ms: number) {
  const seconds = Math.ceil(ms / 1000);
  const hours = Math.floor(seconds / 3600), rest = `${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
  return hours > 0 ? `${hours}:${rest}` : rest;
}
/** 75 -> "1 h 15 min" */
function formatMinutes(minutes: number) {
  if (minutes < 60) return `${minutes} minutos`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} ${hours === 1 ? "hora" : "horas"}`;
}

function Icon({ name }: { name: IconName }) {
  const paths = {
    plus: <><path d="M12 5v14M5 12h14" /></>,
    trash: <><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5" /></>,
    paperclip: <path d="m21.4 11.1-9.2 9.2a5.5 5.5 0 0 1-7.8-7.8l9.2-9.2a3.5 3.5 0 0 1 5 5l-9.2 9.2a1.5 1.5 0 0 1-2.1-2.1l8.5-8.5" />,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    x: <><path d="m6 6 12 12M18 6 6 18" /></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M10 21h4" /></>,
    archive: <><path d="M4 4h16v4H4zM6 8v12h12V8M9 12h6" /></>,
    edit: <><path d="m4 16-.8 4.8L8 20l11.4-11.4a2.1 2.1 0 0 0-3-3L5 17" /><path d="m14.5 7.5 2 2" /></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function ImageViewer({ src, onClose, onSave }: { src: string; onClose: () => void; onSave: (image: Blob) => Promise<void> }) {
  const baseRef = useRef<HTMLCanvasElement>(null);
  const markRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef({ x: 0, y: 0 });
  const history = useRef<ImageData[]>([]);
  const [color, setColor] = useState(highlightColors[0]);
  const [dirty, setDirty] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const image = new Image();
    // Signed Supabase URLs are cross-origin; without this the canvas cannot be exported.
    image.crossOrigin = "anonymous";
    image.onload = () => {
      const base = baseRef.current, mark = markRef.current;
      if (!base || !mark) return;
      base.width = mark.width = image.naturalWidth;
      base.height = mark.height = image.naturalHeight;
      base.getContext("2d")?.drawImage(image, 0, 0);
    };
    image.src = src;
  }, [src]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) { if (event.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function point(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = event.currentTarget, rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height };
  }
  function strokeTo(to: { x: number; y: number }) {
    const mark = markRef.current, context = mark?.getContext("2d");
    if (!mark || !context) return;
    context.strokeStyle = color; context.lineWidth = Math.max(mark.width, mark.height) / 45; context.lineCap = "round"; context.lineJoin = "round";
    context.beginPath(); context.moveTo(last.current.x, last.current.y); context.lineTo(to.x, to.y); context.stroke();
    last.current = to;
  }
  function startStroke(event: ReactPointerEvent<HTMLCanvasElement>) {
    const mark = markRef.current, context = mark?.getContext("2d");
    if (!mark || !context || !mark.width || saving) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    history.current.push(context.getImageData(0, 0, mark.width, mark.height));
    drawing.current = true; setDirty(true); setCanUndo(true);
    const start = point(event); last.current = { x: start.x - 0.1, y: start.y }; strokeTo(start);
  }
  function moveStroke(event: ReactPointerEvent<HTMLCanvasElement>) { if (drawing.current) strokeTo(point(event)); }
  function undo() {
    const mark = markRef.current, previous = history.current.pop();
    if (mark && previous) mark.getContext("2d")?.putImageData(previous, 0, 0);
    setCanUndo(history.current.length > 0);
  }
  function clearMarks() {
    const mark = markRef.current, context = mark?.getContext("2d");
    if (!mark || !context) return;
    history.current.push(context.getImageData(0, 0, mark.width, mark.height));
    context.clearRect(0, 0, mark.width, mark.height); setDirty(true); setCanUndo(true);
  }
  function save() {
    const base = baseRef.current, mark = markRef.current;
    if (!base || !mark) return;
    const output = document.createElement("canvas");
    output.width = base.width; output.height = base.height;
    const context = output.getContext("2d");
    if (!context) return;
    context.drawImage(base, 0, 0);
    context.globalAlpha = 0.45; context.globalCompositeOperation = "multiply"; context.drawImage(mark, 0, 0);
    setSaving(true);
    output.toBlob(async (blob) => {
      if (blob) await onSave(blob);
      setSaving(false);
    }, "image/png");
  }

  return (
    <div className="lightbox" onClick={() => { if (!dirty && !saving) onClose(); }}>
      <div className="viewer-toolbar" onClick={(event) => event.stopPropagation()}>
        <span>Resaltar</span>
        {highlightColors.map((item) => <button key={item} className={`highlight-swatch ${item === color ? "chosen" : ""}`} style={{ background: item }} onClick={() => setColor(item)} aria-label="Elegir color de resaltado" />)}
        <button className="viewer-action" onClick={undo} disabled={!canUndo || saving}>Deshacer</button>
        <button className="viewer-action" onClick={clearMarks} disabled={saving}>Borrar todo</button>
        <button className="viewer-action primary" onClick={save} disabled={!dirty || saving}>{saving ? "Guardando…" : "Guardar"}</button>
        <button className="viewer-close" onClick={onClose} disabled={saving} aria-label="Cerrar imagen"><Icon name="x" /></button>
      </div>
      <div className="viewer-stage" onClick={(event) => event.stopPropagation()}>
        <canvas ref={baseRef} />
        <canvas ref={markRef} className="viewer-marks" onPointerDown={startStroke} onPointerMove={moveStroke} onPointerUp={() => { drawing.current = false; }} onPointerCancel={() => { drawing.current = false; }} />
      </div>
    </div>
  );
}

function StatusScreen({ title, children }: { title: string; children?: React.ReactNode }) {
  return <main className="status-screen"><div><h2>{title}</h2>{children}</div></main>;
}

type AuthMode = "signin" | "signup" | "reset";

function AuthScreen() {
  const [mode, setMode] = useState<AuthMode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [info, setInfo] = useState<string>();

  function switchMode(next: AuthMode) { setMode(next); setError(undefined); setInfo(undefined); }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(undefined); setInfo(undefined);
    try {
      const cleanEmail = email.trim();
      if (mode === "signin") await api.signIn(cleanEmail, password);
      if (mode === "signup") {
        const needsConfirmation = await api.signUp(cleanEmail, password);
        if (needsConfirmation) { setInfo(`Te enviamos un email a ${cleanEmail}. Abrí el link para confirmar la cuenta y después ingresá.`); setMode("signin"); }
      }
      if (mode === "reset") { await api.sendPasswordReset(cleanEmail); setInfo(`Si existe una cuenta con ${cleanEmail}, te llegará un email para elegir una contraseña nueva.`); }
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  const titles: Record<AuthMode, string> = { signin: "Ingresá a Anota", signup: "Creá tu cuenta", reset: "Recuperá tu contraseña" };
  const actions: Record<AuthMode, string> = { signin: "Ingresar", signup: "Crear cuenta", reset: "Enviar email" };

  return (
    <main className="status-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand">Anota</div>
        <h2>{titles[mode]}</h2>
        {mode !== "reset" && <div className="auth-tabs"><button type="button" className={mode === "signin" ? "active" : ""} onClick={() => switchMode("signin")}>Ingresar</button><button type="button" className={mode === "signup" ? "active" : ""} onClick={() => switchMode("signup")}>Crear cuenta</button></div>}
        <label>Email<input type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        {mode !== "reset" && <label>Contraseña<input type="password" required minLength={6} autoComplete={mode === "signup" ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} /></label>}
        {mode === "signup" && <small className="auth-hint">Mínimo 6 caracteres.</small>}
        {error && <p className="auth-error">{error}</p>}
        {info && <p className="auth-info">{info}</p>}
        <button className="save-button" disabled={busy}>{busy ? "Un momento…" : actions[mode]}</button>
        {mode === "signin" && <button type="button" className="auth-link" onClick={() => switchMode("reset")}>¿Olvidaste tu contraseña?</button>}
        {mode === "reset" && <button type="button" className="auth-link" onClick={() => switchMode("signin")}>Volver a ingresar</button>}
      </form>
    </main>
  );
}

function NewPasswordScreen() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(undefined);
    try { await api.updatePassword(password); } catch (reason) { setError(messageOf(reason)); } finally { setBusy(false); }
  }

  return (
    <main className="status-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand">Anota</div>
        <h2>Elegí una contraseña nueva</h2>
        <label>Contraseña nueva<input type="password" required minLength={6} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <small className="auth-hint">Mínimo 6 caracteres.</small>
        {error && <p className="auth-error">{error}</p>}
        <button className="save-button" disabled={busy}>{busy ? "Guardando…" : "Guardar contraseña"}</button>
      </form>
    </main>
  );
}

function Workspace({ user }: { user: AccountUser }) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string>();
  const [error, setError] = useState<string>();
  const [initiatives, setInitiatives] = useState<Initiative[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [reminderMinutes, setReminderMinutesState] = useState(30);
  const [dismissedReminder, setDismissedReminder] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [selectedId, setSelectedId] = useState<string>();
  const [input, setInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [savingMeeting, setSavingMeeting] = useState(false);
  const [newPriority, setNewPriority] = useState<Priority>("media");
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(colors[0]);
  const [showNew, setShowNew] = useState(false);
  const [pendingImage, setPendingImage] = useState<PendingImage>();
  const [viewingMeetingId, setViewingMeetingId] = useState<string>();
  const [zoom, setZoom] = useState<Task>();
  const [editingInitiativeId, setEditingInitiativeId] = useState<string>();
  const [editingInitiativeName, setEditingInitiativeName] = useState("");
  const [editingMeetingId, setEditingMeetingId] = useState<string>();
  const [editingMeetingTitle, setEditingMeetingTitle] = useState("");
  const [editingTaskId, setEditingTaskId] = useState<string>();
  const [editingTaskText, setEditingTaskText] = useState("");

  const selected = initiatives.find((initiative) => initiative.id === selectedId) ?? initiatives[0];
  const viewingMeeting = meetings.find((meeting) => meeting.id === viewingMeetingId);
  const initiativeOf = (task: Task) => initiatives.find((item) => item.id === task.initiativeId);
  const pendingByInitiative = useMemo(() => initiatives.map((initiative) => ({ ...initiative, count: tasks.filter((task) => task.initiativeId === initiative.id).length })), [initiatives, tasks]);
  // High priority first, then medium, then low. Within each, the newest first.
  const sortedMeetings = useMemo(() => [...meetings].sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority] || Date.parse(b.createdAt) - Date.parse(a.createdAt)), [meetings]);

  // The meeting in progress starts with its first note and ends when it is saved.
  const meetingStart = useMemo(() => (tasks.length ? Math.min(...tasks.map((task) => Date.parse(task.createdAt))) : null), [tasks]);
  const elapsed = meetingStart === null ? 0 : Math.max(0, now - meetingStart);
  const intervalMs = reminderMinutes * 60_000;
  const remindersDue = meetingStart === null ? 0 : Math.floor(elapsed / intervalMs);
  const untilNextReminder = intervalMs - (elapsed % intervalMs);
  const reminderProgress = meetingStart === null ? 0 : (elapsed % intervalMs) / intervalMs;
  const showReminderBanner = remindersDue > dismissedReminder;

  useEffect(() => {
    api.loadWorkspace(user.id)
      .then((workspace) => {
        setInitiatives(workspace.initiatives);
        setTasks(workspace.currentTasks);
        setMeetings(workspace.meetings);
        setReminderMinutesState(workspace.reminderMinutes);
        setSelectedId(workspace.initiatives[0]?.id);
        setStatus("ready");
      })
      .catch((reason) => { setLoadError(messageOf(reason)); setStatus("error"); });
  }, [user.id]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  /** Runs a backend call and shows its error in the banner instead of crashing. */
  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    try {
      return await action();
    } catch (reason) {
      setError(messageOf(reason));
      return undefined;
    }
  }
  const succeeded = (action: () => Promise<unknown>) => run(() => action().then(() => true));

  /** Applies a change to a task wherever it is shown: the current list and saved meetings. */
  function patchTask(id: string, change: (task: Task) => Task) {
    const apply = (list: Task[]) => list.map((task) => (task.id === id ? change(task) : task));
    setTasks(apply);
    setMeetings((current) => current.map((meeting) => ({ ...meeting, tasks: apply(meeting.tasks) })));
  }
  function patchMeeting(id: string, change: Partial<Meeting>) {
    setMeetings((current) => current.map((meeting) => (meeting.id === id ? { ...meeting, ...change } : meeting)));
  }

  async function addTask(event?: FormEvent) {
    event?.preventDefault();
    const text = input.trim();
    if (!text || !selected || adding) return;
    setAdding(true);
    const task = await run(() => api.addTask(text, selected.id, pendingImage?.file));
    setAdding(false);
    if (!task) return;
    if (tasks.length === 0) setDismissedReminder(0);
    setTasks((current) => [task, ...current]);
    setInput(""); setPendingImage(undefined);
  }
  async function removeTask(task: Task) {
    if (await succeeded(() => api.deleteTask(task))) setTasks((current) => current.filter((item) => item.id !== task.id));
  }
  async function addInitiative() {
    const name = newName.trim();
    if (!name) return;
    const initiative = await run(() => api.createInitiative(name, newColor));
    if (!initiative) return;
    setInitiatives((current) => [...current, initiative]); setSelectedId(initiative.id); setNewName(""); setShowNew(false);
  }
  function selectImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) setPendingImage({ file, preview: URL.createObjectURL(file) });
    event.target.value = "";
  }
  function pasteImage(event: ClipboardEvent<HTMLElement>) {
    const image = Array.from(event.clipboardData.items).find((item) => item.type.startsWith("image/"));
    const file = image?.getAsFile();
    if (file) { event.preventDefault(); setPendingImage({ file, preview: URL.createObjectURL(file) }); }
  }
  async function saveMeeting() {
    if (tasks.length === 0 || savingMeeting) return;
    const title = `Reunión de equipo · ${formatDay(new Date().toISOString())}`;
    const priority = newPriority;
    setSavingMeeting(true);
    const saved = await run(() => api.saveMeeting(title, priority));
    setSavingMeeting(false);
    if (!saved) return;
    setMeetings((current) => [{ id: saved.id, title, priority, createdAt: saved.createdAt, tasks: tasks.map((task) => ({ ...task, meetingId: saved.id })) }, ...current]);
    setTasks([]);
    setPendingImage(undefined);
    setNewPriority("media");
    setDismissedReminder(0);
  }
  async function changeReminder(minutes: number) {
    const previous = reminderMinutes;
    setReminderMinutesState(minutes);
    // Only remind about intervals that end after the change.
    setDismissedReminder(meetingStart === null ? 0 : Math.floor(elapsed / (minutes * 60_000)));
    if (!(await succeeded(() => api.setReminderMinutes(minutes)))) setReminderMinutesState(previous);
  }
  async function changePriority(meeting: Meeting, priority: Priority) {
    if (priority === meeting.priority) return;
    patchMeeting(meeting.id, { priority });
    if (!(await succeeded(() => api.setMeetingPriority(meeting.id, priority)))) patchMeeting(meeting.id, { priority: meeting.priority });
  }
  async function deleteInitiative(id: string) {
    if (initiatives.length === 1) return;
    if (!(await succeeded(() => api.deleteInitiative(id)))) return;
    setInitiatives((current) => current.filter((item) => item.id !== id));
    setTasks((current) => current.filter((task) => task.initiativeId !== id));
    setMeetings((current) => current.map((meeting) => ({ ...meeting, tasks: meeting.tasks.map((task) => (task.initiativeId === id ? { ...task, initiativeId: null } : task)) })));
    if (selected?.id === id) setSelectedId(initiatives.find((item) => item.id !== id)?.id);
  }
  function startInitiativeEdit(initiative: Initiative) { setEditingInitiativeId(initiative.id); setEditingInitiativeName(initiative.name); }
  async function saveInitiativeEdit(id: string) {
    const name = editingInitiativeName.trim();
    setEditingInitiativeId(undefined);
    const previous = initiatives.find((item) => item.id === id);
    if (!name || !previous || name === previous.name) return;
    setInitiatives((current) => current.map((item) => (item.id === id ? { ...item, name } : item)));
    if (!(await succeeded(() => api.renameInitiative(id, name)))) setInitiatives((current) => current.map((item) => (item.id === id ? previous : item)));
  }
  async function saveMeetingEdit(id: string) {
    const title = editingMeetingTitle.trim();
    setEditingMeetingId(undefined);
    const previous = meetings.find((meeting) => meeting.id === id);
    if (!title || !previous || title === previous.title) return;
    patchMeeting(id, { title });
    if (!(await succeeded(() => api.renameMeeting(id, title)))) patchMeeting(id, { title: previous.title });
  }
  async function removeMeeting(meeting: Meeting) {
    if (!(await succeeded(() => api.deleteMeeting(meeting)))) return;
    setMeetings((current) => current.filter((item) => item.id !== meeting.id));
    if (viewingMeetingId === meeting.id) setViewingMeetingId(undefined);
  }
  async function saveTaskEdit(task: Task) {
    const text = editingTaskText.trim();
    setEditingTaskId(undefined);
    if (!text || text === task.text) return;
    patchTask(task.id, (item) => ({ ...item, text }));
    if (!(await succeeded(() => api.updateTaskText(task.id, text)))) patchTask(task.id, (item) => ({ ...item, text: task.text }));
  }
  const closeZoom = useCallback(() => setZoom(undefined), []);
  async function saveHighlight(task: Task, image: Blob) {
    const updated = await run(() => api.replaceTaskImage(task, image));
    if (!updated) return;
    patchTask(task.id, () => updated);
    setZoom(undefined);
  }
  async function signOut() {
    await run(() => api.signOut());
  }

  if (status === "loading") return <StatusScreen title="Cargando tus notas…"><p>Conectando con Supabase.</p></StatusScreen>;
  if (status === "error") {
    return <StatusScreen title="No se pudo conectar"><p>{loadError}</p><button className="save-button" onClick={() => window.location.reload()}>Reintentar</button><button className="auth-link" onClick={signOut}>Cerrar sesión</button></StatusScreen>;
  }

  const reminderOptionList = reminderOptions.includes(reminderMinutes) ? reminderOptions : [...reminderOptions, reminderMinutes].sort((a, b) => a - b);
  const reminderLabel = meetingStart === null ? "Sin reunión en curso" : remindersDue > 0 ? "Es hora de pasar en limpio" : "Próximo recordatorio en";

  return (
    <main className="app-shell" onPaste={pasteImage}>
      <header className="topbar">
        <div className="brand">Anota <span>{meetingStart === null ? "Sin reunión en curso" : "Reunión en curso"}</span></div>
        <div className="topbar-right">
          <div className={`timer ${meetingStart === null ? "idle" : ""}`} title="Tiempo desde la primera nota de la reunión"><Icon name="clock" /> {formatClock(elapsed)}</div>
          <div className="account"><span title={user.email}>{user.email}</span><button onClick={signOut}>Salir</button></div>
        </div>
      </header>
      {error && <div className="notice error-notice"><span>{error}</span><button onClick={() => setError(undefined)} aria-label="Cerrar error"><Icon name="x" /></button></div>}
      {showReminderBanner && <div className="notice"><Icon name="bell" /><span>Pasaron {formatMinutes(remindersDue * reminderMinutes)} — tenés <strong>{tasks.length} {tasks.length === 1 ? "tarea" : "tareas"}</strong> para pasar en limpio. Revisalas y guardá la reunión cuando termines.</span><button onClick={() => setDismissedReminder(remindersDue)} aria-label="Cerrar aviso"><Icon name="x" /></button></div>}
      <div className="workspace">
        <aside className="sidebar panel-border"><h2>Iniciativas</h2><div className="initiative-list">
          {pendingByInitiative.map((initiative) => <div className={`initiative ${initiative.id === selected?.id ? "is-selected" : ""}`} key={initiative.id} onClick={() => setSelectedId(initiative.id)}><i style={{ background: initiative.color }} />{editingInitiativeId === initiative.id ? <input className="inline-edit" autoFocus value={editingInitiativeName} onChange={(event) => setEditingInitiativeName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") saveInitiativeEdit(initiative.id); if (event.key === "Escape") setEditingInitiativeId(undefined); }} onBlur={() => saveInitiativeEdit(initiative.id)} /> : <div><b>{initiative.name}</b><small>{initiative.count} pendientes</small></div>}<button aria-label={`Editar ${initiative.name}`} onClick={(event) => { event.stopPropagation(); startInitiativeEdit(initiative); }}><Icon name="edit" /></button><button aria-label={`Eliminar ${initiative.name}`} onClick={(event) => { event.stopPropagation(); deleteInitiative(initiative.id); }}><Icon name="trash" /></button></div>)}
          {showNew ? <div className="new-initiative"><input autoFocus value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Nombre de la iniciativa" onKeyDown={(event) => event.key === "Enter" && addInitiative()} /><div className="swatches">{colors.map((color) => <button className={newColor === color ? "chosen" : ""} key={color} style={{ background: color }} onClick={() => setNewColor(color)} aria-label="Elegir color" />)}</div><div className="form-actions"><button onClick={() => setShowNew(false)}>Cancelar</button><button className="primary-small" onClick={addInitiative}>Guardar</button></div></div> : <button className="add-initiative" onClick={() => setShowNew(true)}><Icon name="plus" /> Nueva iniciativa</button>}
          <div className="saved-heading">Reuniones guardadas</div>
          {sortedMeetings.length === 0 && <p className="empty-note">Todavía no guardaste reuniones.</p>}
          {sortedMeetings.map((meeting) => <div className="meeting-row" key={meeting.id}>{editingMeetingId === meeting.id ? <input className="inline-edit" autoFocus value={editingMeetingTitle} onChange={(event) => setEditingMeetingTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") saveMeetingEdit(meeting.id); if (event.key === "Escape") setEditingMeetingId(undefined); }} onBlur={() => saveMeetingEdit(meeting.id)} /> : <button onClick={() => setViewingMeetingId(meeting.id)}><b>{meeting.title}</b><small><span className={`priority-badge priority-${meeting.priority}`}>{PRIORITY_LABELS[meeting.priority]}</span> {meeting.tasks.length} tareas · {formatDay(meeting.createdAt)}</small></button>}<button aria-label="Editar reunión" onClick={() => { setEditingMeetingId(meeting.id); setEditingMeetingTitle(meeting.title); }}><Icon name="edit" /></button><button aria-label="Eliminar reunión" onClick={() => removeMeeting(meeting)}><Icon name="trash" /></button></div>)}
        </div></aside>
        <section className="capture panel-border"><div className="section-title"><h2>Captura rápida</h2><span>⌘ + Enter para anotar · Ctrl/Cmd + V para pegar imagen</span></div><div className="chips">{initiatives.map((initiative) => <button key={initiative.id} className={initiative.id === selected?.id ? "chip active" : "chip"} onClick={() => setSelectedId(initiative.id)}><i style={{ background: initiative.color }} />{initiative.name}</button>)}</div><form className="capture-form" onSubmit={addTask}><input value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) addTask(); }} placeholder="¿Qué hay que hacer?" aria-label="Nueva tarea" /><label className="icon-button" aria-label="Adjuntar imagen"><Icon name="paperclip" /><input type="file" accept="image/*" onChange={selectImage} /></label><button className="add-button" aria-label="Agregar tarea" disabled={adding}><Icon name="plus" /></button></form>{pendingImage && <div className="attachment"><img src={pendingImage.preview} alt="Vista previa del adjunto" /><span>{adding ? "Subiendo imagen…" : "Imagen lista para adjuntar"}</span><button type="button" onClick={() => setPendingImage(undefined)}><Icon name="x" /></button></div>}<div className="task-count">{tasks.length} anotadas esta reunión</div><div className="task-grid">{tasks.map((task) => { const initiative = initiativeOf(task); return <article className="task" key={task.id}><i style={{ background: initiative?.color ?? "#B8AFA0" }} />{editingTaskId === task.id ? <input className="inline-edit" autoFocus value={editingTaskText} onChange={(event) => setEditingTaskText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") saveTaskEdit(task); if (event.key === "Escape") setEditingTaskId(undefined); }} onBlur={() => saveTaskEdit(task)} /> : <div><p>{task.text}</p><small>{initiative?.name ?? "Sin iniciativa"} · {formatTime(task.createdAt)}</small></div>}{task.image && <button className="thumb" onClick={() => setZoom(task)} aria-label="Ampliar imagen"><img src={task.image} alt="Adjunto" /></button>}<button aria-label="Editar tarea" onClick={() => { setEditingTaskId(task.id); setEditingTaskText(task.text); }}><Icon name="edit" /></button><button aria-label="Eliminar tarea" onClick={() => removeTask(task)}><Icon name="trash" /></button></article>; })}</div></section>
        <aside className="reminder"><h2>Recordatorio</h2><div className="reminder-body">
          <div className="progress"><span style={{ width: `${reminderProgress * 100}%` }} /></div>
          <div className={`reminder-label ${remindersDue > 0 ? "due" : ""}`}>{reminderLabel}</div>
          <div className="reminder-time"><strong>{meetingStart === null ? formatCountdown(intervalMs) : formatCountdown(untilNextReminder)}</strong></div>
          <label className="reminder-interval">Avisarme cada <select value={reminderMinutes} onChange={(event) => changeReminder(Number(event.target.value))}>{reminderOptionList.map((minutes) => <option key={minutes} value={minutes}>{formatMinutes(minutes)}</option>)}</select></label>
          <p>{meetingStart === null ? "El reloj arranca cuando anotás la primera tarea de la reunión." : "Cuando termine la reunión, revisá cada nota y convertí lo importante en una tarea clara."}</p>
          <div className="priority-picker" role="radiogroup" aria-label="Prioridad de la reunión"><span>Prioridad</span>{PRIORITIES.map((priority) => <button key={priority} type="button" role="radio" aria-checked={newPriority === priority} className={`priority-option priority-${priority} ${newPriority === priority ? "chosen" : ""}`} onClick={() => setNewPriority(priority)}>{PRIORITY_LABELS[priority]}</button>)}</div>
          <button className="save-button" onClick={saveMeeting} disabled={tasks.length === 0 || savingMeeting}><Icon name="archive" /> {savingMeeting ? "Guardando…" : "Guardar reunión"}</button>
          <div className="tip"><span>⌁</span><div><b>Un buen momento para ordenar</b><br />Las notas rápidas son más útiles cuando las limpiás mientras todavía tenés el contexto fresco.</div></div>
        </div></aside>
      </div>
      {viewingMeeting && <div className="modal-backdrop" onClick={() => setViewingMeetingId(undefined)}><div className="modal" onClick={(event) => event.stopPropagation()}><div className="modal-header"><div><h2>{viewingMeeting.title}</h2><small>{viewingMeeting.tasks.length} tareas · {formatDay(viewingMeeting.createdAt)}</small></div><div className="modal-actions"><select className={`priority-select priority-${viewingMeeting.priority}`} value={viewingMeeting.priority} onChange={(event) => changePriority(viewingMeeting, event.target.value as Priority)} aria-label="Prioridad">{PRIORITIES.map((priority) => <option key={priority} value={priority}>Prioridad {PRIORITY_LABELS[priority].toLowerCase()}</option>)}</select><button onClick={() => setViewingMeetingId(undefined)} aria-label="Cerrar"><Icon name="x" /></button></div></div><div className="modal-list">{viewingMeeting.tasks.map((task) => <div className="task" key={task.id}><i style={{ background: initiativeOf(task)?.color ?? "#B8AFA0" }} /><div><p>{task.text}</p><small>{initiativeOf(task)?.name ?? "Sin iniciativa"} · {formatTime(task.createdAt)}</small></div>{task.image && <button className="thumb" onClick={() => setZoom(task)} aria-label="Ampliar imagen"><img src={task.image} alt="Adjunto" /></button>}</div>)}</div></div></div>}
      {zoom?.image && <ImageViewer key={zoom.image} src={zoom.image} onClose={closeZoom} onSave={(image) => saveHighlight(zoom, image)} />}
    </main>
  );
}

export default function Home() {
  const [auth, setAuth] = useState<AuthState | "loading">("loading");

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    return api.watchAuth((next, event) => {
      // Stay on the new-password form until the password is actually changed.
      setAuth((previous) => (previous !== "loading" && previous.status === "recovery" && event !== "USER_UPDATED" && event !== "SIGNED_OUT" ? previous : next));
    });
  }, []);

  if (!isSupabaseConfigured) {
    return <StatusScreen title="Falta configurar Supabase"><p>Creá el archivo <code>.env.local</code> con <code>NEXT_PUBLIC_SUPABASE_URL</code> y <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code>, y reiniciá el servidor.</p></StatusScreen>;
  }
  if (auth === "loading") return <StatusScreen title="Cargando…" />;
  if (auth.status === "recovery") return <NewPasswordScreen />;
  if (auth.status === "out") return <AuthScreen />;
  return <Workspace key={auth.user.id} user={auth.user} />;
}
