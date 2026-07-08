"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const { parsearPedidos } = require("./pedido-parser");

const DATA_DIR = path.join(__dirname, "data");
const CONFIG_FILE = path.join(DATA_DIR, "imap-config.json");
const STATE_FILE = path.join(DATA_DIR, "imap-state.json");
const COLA_FILE = path.join(DATA_DIR, "pedidos-cola.json");
const MASK = "********";

const CONFIG_DEFAULT = {
  host: "", port: 993, secure: true, user: "", password: "",
  folder: "INBOX", intervalMinutes: 5, enabled: false
};
const STATE_DEFAULT = { ultimaRevision: null, ultimoError: null, messageIdsProcesados: [] };

function asegurarDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function leerJson(archivo, porDefecto) {
  try {
    const s = fs.readFileSync(archivo, "utf8");
    return { ...porDefecto, ...JSON.parse(s) };
  } catch (e) {
    return { ...porDefecto };
  }
}
function escribirJson(archivo, data) {
  asegurarDataDir();
  fs.writeFileSync(archivo, JSON.stringify(data, null, 2), "utf8");
}

function leerConfig() { return leerJson(CONFIG_FILE, CONFIG_DEFAULT); }
function leerEstado() { return leerJson(STATE_FILE, STATE_DEFAULT); }
function leerCola() {
  try { return JSON.parse(fs.readFileSync(COLA_FILE, "utf8")); } catch (e) { return []; }
}
function escribirCola(cola) { escribirJson(COLA_FILE, cola); }

function configPublica() {
  const c = leerConfig();
  return { ...c, password: c.password ? MASK : "" };
}

function guardarConfig(entrada) {
  const actual = leerConfig();
  const nueva = {
    host: String(entrada.host || "").trim(),
    port: Number(entrada.port) || 993,
    secure: entrada.secure !== false,
    user: String(entrada.user || "").trim(),
    password: entrada.password === MASK ? actual.password : String(entrada.password || ""),
    folder: String(entrada.folder || "INBOX").trim() || "INBOX",
    intervalMinutes: Math.max(1, Number(entrada.intervalMinutes) || 5),
    enabled: !!entrada.enabled
  };
  escribirJson(CONFIG_FILE, nueva);
  reprogramar();
  return configPublica();
}

async function conectar(cfg) {
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.password },
    logger: false
  });
  await client.connect();
  return client;
}

async function probarConexion(cfgParcial) {
  const base = leerConfig();
  const cfg = {
    host: String((cfgParcial && cfgParcial.host) || base.host || "").trim(),
    port: Number((cfgParcial && cfgParcial.port) || base.port) || 993,
    secure: cfgParcial && cfgParcial.secure != null ? !!cfgParcial.secure : base.secure,
    user: String((cfgParcial && cfgParcial.user) || base.user || "").trim(),
    password: cfgParcial && cfgParcial.password && cfgParcial.password !== MASK ? cfgParcial.password : base.password,
    folder: String((cfgParcial && cfgParcial.folder) || base.folder || "INBOX").trim() || "INBOX"
  };
  if (!cfg.host || !cfg.user || !cfg.password) {
    return { ok: false, error: "Completá host, usuario y contraseña" };
  }
  let client;
  try {
    client = await conectar(cfg);
    const lock = await client.getMailboxLock(cfg.folder);
    lock.release();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  } finally {
    if (client) { try { await client.logout(); } catch (e) {} }
  }
}

function textoDeMensaje(parsed) {
  if (parsed.text && parsed.text.trim()) return parsed.text;
  if (parsed.html) return String(parsed.html).replace(/<[^>]+>/g, "\n");
  return "";
}

async function revisarAhora() {
  const cfg = leerConfig();
  const estado = leerEstado();
  if (!cfg.host || !cfg.user || !cfg.password) {
    return { ok: false, error: "Faltan datos de la casilla: guardá host, usuario y contraseña primero", nuevas: 0 };
  }
  let client;
  let nuevas = 0, revisadas = 0;
  try {
    client = await conectar(cfg);
    const lock = await client.getMailboxLock(cfg.folder);
    try {
      const uids = await client.search({ seen: false }, { uid: true });
      const procesados = new Set(estado.messageIdsProcesados || []);
      for (const uid of uids || []) {
        revisadas++;
        let msg;
        for await (const m of client.fetch(uid, { source: true }, { uid: true })) { msg = m; }
        if (!msg || !msg.source) continue;
        const parsed = await simpleParser(msg.source);
        const messageId = parsed.messageId || ("uid-" + uid + "-" + cfg.host);
        if (procesados.has(messageId)) {
          await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
          continue;
        }
        const texto = textoDeMensaje(parsed);
        const pedidos = parsearPedidos(texto);
        if (pedidos.length) {
          const cola = leerCola();
          const ahora = new Date().toISOString().slice(0, 10);
          pedidos.forEach(p => {
            cola.push({
              colaId: crypto.randomUUID(),
              fecha: ahora,
              sector: p.sector || "",
              solicitante: p.solicitante || (parsed.from && parsed.from.text) || "(email)",
              producto: p.producto,
              cantidad: p.cantidad || 1,
              monto: p.monto || 0,
              asunto: parsed.subject || "",
              messageId
            });
          });
          escribirCola(cola);
          nuevas += pedidos.length;
        }
        procesados.add(messageId);
        await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
      }
      estado.messageIdsProcesados = Array.from(procesados).slice(-2000);
    } finally {
      lock.release();
    }
    estado.ultimaRevision = new Date().toISOString();
    estado.ultimoError = null;
    escribirJson(STATE_FILE, estado);
    return { ok: true, revisadas, nuevas };
  } catch (e) {
    estado.ultimaRevision = new Date().toISOString();
    estado.ultimoError = e.message || String(e);
    escribirJson(STATE_FILE, estado);
    return { ok: false, error: estado.ultimoError, revisadas, nuevas };
  } finally {
    if (client) { try { await client.logout(); } catch (e) {} }
  }
}

function estadoPublico() {
  const cfg = leerConfig();
  const estado = leerEstado();
  return {
    enabled: cfg.enabled,
    intervalMinutes: cfg.intervalMinutes,
    ultimaRevision: estado.ultimaRevision,
    ultimoError: estado.ultimoError,
    pendientesEnCola: leerCola().length
  };
}

function obtenerCola() { return leerCola(); }
function confirmarCola(ids) {
  const set = new Set(ids || []);
  const cola = leerCola().filter(p => !set.has(p.colaId));
  escribirCola(cola);
  return cola.length;
}

let temporizador = null;
function reprogramar() {
  if (temporizador) { clearInterval(temporizador); temporizador = null; }
  const cfg = leerConfig();
  if (!cfg.enabled) return;
  const ms = Math.max(1, cfg.intervalMinutes) * 60000;
  temporizador = setInterval(() => { revisarAhora().catch(() => {}); }, ms);
}

function iniciar() {
  reprogramar();
  const cfg = leerConfig();
  if (cfg.enabled) revisarAhora().catch(() => {});
}

module.exports = {
  iniciar, configPublica, guardarConfig, probarConexion,
  revisarAhora, estadoPublico, obtenerCola, confirmarCola, MASK
};
