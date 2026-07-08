"use strict";
const express = require("express");
const path = require("path");
const imap = require("./imap-worker");

const app = express();
app.use(express.json());

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

function requiereToken(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ error: "El servidor no tiene configurada la variable de entorno ADMIN_TOKEN; la API de pedidos por email está deshabilitada." });
  }
  if (req.get("x-admin-token") !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "Token de administración inválido" });
  }
  next();
}

app.get("/api/imap/config", requiereToken, (req, res) => {
  res.json(imap.configPublica());
});
app.post("/api/imap/config", requiereToken, (req, res) => {
  res.json(imap.guardarConfig(req.body || {}));
});
app.post("/api/imap/probar", requiereToken, async (req, res) => {
  res.json(await imap.probarConexion(req.body || {}));
});
app.post("/api/imap/revisar-ahora", requiereToken, async (req, res) => {
  res.json(await imap.revisarAhora());
});
app.get("/api/imap/estado", requiereToken, (req, res) => {
  res.json(imap.estadoPublico());
});
app.get("/api/pedidos-cola", requiereToken, (req, res) => {
  res.json(imap.obtenerCola());
});
app.post("/api/pedidos-cola/ack", requiereToken, (req, res) => {
  const ids = (req.body && req.body.ids) || [];
  res.json({ pendientes: imap.confirmarCola(ids) });
});

app.use(express.static(__dirname, { extensions: ["html"] }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Gestión de Compras escuchando en el puerto " + PORT);
  if (!ADMIN_TOKEN) {
    console.warn("ADMIN_TOKEN no está configurado: la recepción automática de pedidos por email queda deshabilitada hasta setearlo.");
  }
  imap.iniciar();
});
