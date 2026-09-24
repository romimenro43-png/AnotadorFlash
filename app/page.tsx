"use client";

import { ChangeEvent, ClipboardEvent, FormEvent, PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../lib/data";
import type { Initiative, Meeting, Task } from "../lib/data";
import { isSupabaseConfigured } from "../lib/supabase";

type IconName = "plus" | "trash" | "paperclip" | "clock" | "x" | "bell" | "archive" | "edit";
type PendingImage = { file: Blob; preview: string };

const colors = ["#D97757", "#5F8F82", "#B9913F", "#8B6F9E", "#4B7A9B", "#A96F52"];
const highlightColors = ["#FFE14D", "#7CE0A3", "#FF8FB1", "#7DC8FF"];

const formatTime = (iso: string) => new Date(iso).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
const messageOf = (error: unknown) => (error instanceof Error ? error.message : "Ocurrió un error inesperado.");

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

function StatusScreen({ title, children }: { title: string; children: React.ReactNode }) {
  return <main className="status-screen"><div><h2>{title}</h2>{children}</div></main>;
}

export default function Home() {
  const [status, setStatus] = useState<"loading" | "ready" | "error">(isSupabaseConfigured ? "loading" : "error");
  const [loadError, setLoadError] = useState<string>();
  const [error, setError] = useState<string>();
  const [initiatives, setInitiatives] = useState<Initiative[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [input, setInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [savingMeeting, setSavingMeeting] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(colors[0]);
  const [showNew, setShowNew] = useState(false);
  const [showBanner, setShowBanner] = useState(true);
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

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    api.loadWorkspace()
      .then((workspace) => {
        setInitiatives(workspace.initiatives);
        setTasks(workspace.currentTasks);
        setMeetings(workspace.meetings);
        setSelectedId(workspace.initiatives[0]?.id);
        setStatus("ready");
      })
      .catch((reason) => { setLoadError(messageOf(reason)); setStatus("error"); });
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

  /** Applies a change to a task wherever it is shown: the current list and saved meetings. */
  function patchTask(id: string, change: (task: Task) => Task) {
    const apply = (list: Task[]) => list.map((task) => (task.id === id ? change(task) : task));
    setTasks(apply);
    setMeetings((current) => current.map((meeting) => ({ ...meeting, tasks: apply(meeting.tasks) })));
  }

  async function addTask(event?: FormEvent) {
    event?.preventDefault();
    const text = input.trim();
    if (!text || !selected || adding) return;
    setAdding(true);
    const task = await run(() => api.addTask(text, selected.id, pendingImage?.file));
    setAdding(false);
    if (!task) return;
    setTasks((current) => [task, ...current]);
    setInput(""); setPendingImage(undefined);
  }
  async function removeTask(task: Task) {
    if (await run(() => api.deleteTask(task).then(() => true))) setTasks((current) => current.filter((item) => item.id !== task.id));
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
    const title = `Reunión de equipo · ${new Date().toLocaleDateString("es-AR", { day: "numeric", month: "short" })}`;
    setSavingMeeting(true);
    const saved = await run(() => api.saveMeeting(title));
    setSavingMeeting(false);
    if (!saved) return;
    setMeetings((current) => [{ id: saved.id, title, createdAt: saved.createdAt, tasks: tasks.map((task) => ({ ...task, meetingId: saved.id })) }, ...current]);
    setTasks([]);
    setPendingImage(undefined);
  }
  async function deleteInitiative(id: string) {
    if (initiatives.length === 1) return;
    if (!(await run(() => api.deleteInitiative(id).then(() => true)))) return;
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
    if (!name || name === previous?.name) return;
    setInitiatives((current) => current.map((item) => (item.id === id ? { ...item, name } : item)));
    if (!(await run(() => api.renameInitiative(id, name).then(() => true))) && previous) setInitiatives((current) => current.map((item) => (item.id === id ? previous : item)));
  }
  async function saveMeetingEdit(id: string) {
    const title = editingMeetingTitle.trim();
    setEditingMeetingId(undefined);
    const previous = meetings.find((meeting) => meeting.id === id);
    if (!title || !previous || title === previous.title) return;
    setMeetings((current) => current.map((meeting) => (meeting.id === id ? { ...meeting, title } : meeting)));
    if (!(await run(() => api.renameMeeting(id, title).then(() => true)))) setMeetings((current) => current.map((meeting) => (meeting.id === id ? { ...meeting, title: previous.title } : meeting)));
  }
  async function removeMeeting(meeting: Meeting) {
    if (!(await run(() => api.deleteMeeting(meeting).then(() => true)))) return;
    setMeetings((current) => current.filter((item) => item.id !== meeting.id));
    if (viewingMeetingId === meeting.id) setViewingMeetingId(undefined);
  }
  async function saveTaskEdit(task: Task) {
    const text = editingTaskText.trim();
    setEditingTaskId(undefined);
    if (!text || text === task.text) return;
    patchTask(task.id, (item) => ({ ...item, text }));
    if (!(await run(() => api.updateTaskText(task.id, text).then(() => true)))) patchTask(task.id, (item) => ({ ...item, text: task.text }));
  }
  const closeZoom = useCallback(() => setZoom(undefined), []);
  async function saveHighlight(task: Task, image: Blob) {
    const updated = await run(() => api.replaceTaskImage(task, image));
    if (!updated) return;
    patchTask(task.id, () => updated);
    setZoom(undefined);
  }

  if (!isSupabaseConfigured) {
    return <StatusScreen title="Falta configurar Supabase"><p>Creá el archivo <code>.env.local</code> con <code>NEXT_PUBLIC_SUPABASE_URL</code> y <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code>, y reiniciá el servidor.</p></StatusScreen>;
  }
  if (status === "loading") return <StatusScreen title="Cargando tus notas…"><p>Conectando con Supabase.</p></StatusScreen>;
  if (status === "error") {
    return <StatusScreen title="No se pudo conectar"><p>{loadError}</p><button className="save-button" onClick={() => window.location.reload()}>Reintentar</button></StatusScreen>;
  }

  return (
    <main className="app-shell" onPaste={pasteImage}>
      <header className="topbar"><div className="brand">Anota <span>Reunión en curso</span></div><div className="timer"><Icon name="clock" /> 00:42:18</div></header>
      {error && <div className="notice error-notice"><span>{error}</span><button onClick={() => setError(undefined)} aria-label="Cerrar error"><Icon name="x" /></button></div>}
      {showBanner && <div className="notice"><Icon name="bell" /><span>Pasaron 30 minutos — tenés <strong>{tasks.length} tareas</strong> para pasar en limpio. Revisalas en el panel de la derecha.</span><button onClick={() => setShowBanner(false)} aria-label="Cerrar aviso"><Icon name="x" /></button></div>}
      <div className="workspace">
        <aside className="sidebar panel-border"><h2>Iniciativas</h2><div className="initiative-list">
          {pendingByInitiative.map((initiative) => <div className={`initiative ${initiative.id === selected?.id ? "is-selected" : ""}`} key={initiative.id} onClick={() => setSelectedId(initiative.id)}><i style={{ background: initiative.color }} />{editingInitiativeId === initiative.id ? <input className="inline-edit" autoFocus value={editingInitiativeName} onChange={(event) => setEditingInitiativeName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") saveInitiativeEdit(initiative.id); if (event.key === "Escape") setEditingInitiativeId(undefined); }} onBlur={() => saveInitiativeEdit(initiative.id)} /> : <div><b>{initiative.name}</b><small>{initiative.count} pendientes</small></div>}<button aria-label={`Editar ${initiative.name}`} onClick={(event) => { event.stopPropagation(); startInitiativeEdit(initiative); }}><Icon name="edit" /></button><button aria-label={`Eliminar ${initiative.name}`} onClick={(event) => { event.stopPropagation(); deleteInitiative(initiative.id); }}><Icon name="trash" /></button></div>)}
          {showNew ? <div className="new-initiative"><input autoFocus value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Nombre de la iniciativa" onKeyDown={(event) => event.key === "Enter" && addInitiative()} /><div className="swatches">{colors.map((color) => <button className={newColor === color ? "chosen" : ""} key={color} style={{ background: color }} onClick={() => setNewColor(color)} aria-label="Elegir color" />)}</div><div className="form-actions"><button onClick={() => setShowNew(false)}>Cancelar</button><button className="primary-small" onClick={addInitiative}>Guardar</button></div></div> : <button className="add-initiative" onClick={() => setShowNew(true)}><Icon name="plus" /> Nueva iniciativa</button>}
          <div className="saved-heading">Reuniones guardadas</div>{meetings.map((meeting) => <div className="meeting-row" key={meeting.id}>{editingMeetingId === meeting.id ? <input className="inline-edit" autoFocus value={editingMeetingTitle} onChange={(event) => setEditingMeetingTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") saveMeetingEdit(meeting.id); if (event.key === "Escape") setEditingMeetingId(undefined); }} onBlur={() => saveMeetingEdit(meeting.id)} /> : <button onClick={() => setViewingMeetingId(meeting.id)}><b>{meeting.title}</b><small>{meeting.tasks.length} tareas</small></button>}<button aria-label="Editar reunión" onClick={() => { setEditingMeetingId(meeting.id); setEditingMeetingTitle(meeting.title); }}><Icon name="edit" /></button><button aria-label="Eliminar reunión" onClick={() => removeMeeting(meeting)}><Icon name="trash" /></button></div>)}
        </div></aside>
        <section className="capture panel-border"><div className="section-title"><h2>Captura rápida</h2><span>⌘ + Enter para anotar · Ctrl/Cmd + V para pegar imagen</span></div><div className="chips">{initiatives.map((initiative) => <button key={initiative.id} className={initiative.id === selected?.id ? "chip active" : "chip"} onClick={() => setSelectedId(initiative.id)}><i style={{ background: initiative.color }} />{initiative.name}</button>)}</div><form className="capture-form" onSubmit={addTask}><input value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) addTask(); }} placeholder="¿Qué hay que hacer?" aria-label="Nueva tarea" /><label className="icon-button" aria-label="Adjuntar imagen"><Icon name="paperclip" /><input type="file" accept="image/*" onChange={selectImage} /></label><button className="add-button" aria-label="Agregar tarea" disabled={adding}><Icon name="plus" /></button></form>{pendingImage && <div className="attachment"><img src={pendingImage.preview} alt="Vista previa del adjunto" /><span>{adding ? "Subiendo imagen…" : "Imagen lista para adjuntar"}</span><button type="button" onClick={() => setPendingImage(undefined)}><Icon name="x" /></button></div>}<div className="task-count">{tasks.length} anotadas esta reunión</div><div className="task-grid">{tasks.map((task) => { const initiative = initiativeOf(task); return <article className="task" key={task.id}><i style={{ background: initiative?.color ?? "#B8AFA0" }} />{editingTaskId === task.id ? <input className="inline-edit" autoFocus value={editingTaskText} onChange={(event) => setEditingTaskText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") saveTaskEdit(task); if (event.key === "Escape") setEditingTaskId(undefined); }} onBlur={() => saveTaskEdit(task)} /> : <div><p>{task.text}</p><small>{initiative?.name ?? "Sin iniciativa"} · {formatTime(task.createdAt)}</small></div>}{task.image && <button className="thumb" onClick={() => setZoom(task)} aria-label="Ampliar imagen"><img src={task.image} alt="Adjunto" /></button>}<button aria-label="Editar tarea" onClick={() => { setEditingTaskId(task.id); setEditingTaskText(task.text); }}><Icon name="edit" /></button><button aria-label="Eliminar tarea" onClick={() => removeTask(task)}><Icon name="trash" /></button></article>; })}</div></section>
        <aside className="reminder"><h2>Recordatorio</h2><div className="reminder-body"><div className="progress"><span style={{ width: `${Math.min(100, tasks.length * 18 + 16)}%` }} /></div><div className="reminder-label">Es hora de pasar en limpio</div><div className="reminder-time"><strong>30:00</strong><span>intervalo sugerido</span></div><p>Cuando termine la reunión, revisá cada nota y convertí lo importante en una tarea clara.</p><button className="save-button" onClick={saveMeeting} disabled={tasks.length === 0 || savingMeeting}><Icon name="archive" /> {savingMeeting ? "Guardando…" : "Guardar reunión"}</button><div className="tip"><span>⌁</span><div><b>Un buen momento para ordenar</b><br />Las notas rápidas son más útiles cuando las limpiás mientras todavía tenés el contexto fresco.</div></div></div></aside>
      </div>
      {viewingMeeting && <div className="modal-backdrop" onClick={() => setViewingMeetingId(undefined)}><div className="modal" onClick={(event) => event.stopPropagation()}><div className="modal-header"><div><h2>{viewingMeeting.title}</h2><small>{viewingMeeting.tasks.length} tareas</small></div><button onClick={() => setViewingMeetingId(undefined)} aria-label="Cerrar"><Icon name="x" /></button></div><div className="modal-list">{viewingMeeting.tasks.map((task) => <div className="task" key={task.id}><i style={{ background: initiativeOf(task)?.color ?? "#B8AFA0" }} /><div><p>{task.text}</p><small>{initiativeOf(task)?.name ?? "Sin iniciativa"} · {formatTime(task.createdAt)}</small></div>{task.image && <button className="thumb" onClick={() => setZoom(task)} aria-label="Ampliar imagen"><img src={task.image} alt="Adjunto" /></button>}</div>)}</div></div></div>}
      {zoom?.image && <ImageViewer key={zoom.image} src={zoom.image} onClose={closeZoom} onSave={(image) => saveHighlight(zoom, image)} />}
    </main>
  );
}
