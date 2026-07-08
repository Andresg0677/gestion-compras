"use strict";
/**
 * Parseo de pedidos en formato "Sector: ... / Solicitante: ... / Producto: ... / Cantidad: ... / Monto: ...".
 * Debe comportarse EXACTAMENTE igual que procesarPedidos() en gestion-compras.html (flujo manual de "pegar texto de mails"),
 * para que un pedido llegado por email automático y uno pegado a mano generen la misma Solicitud.
 */
function parsearPedidos(texto) {
  const campo = (l, n) => {
    const m = l.match(new RegExp("^\\s*" + n + "\\s*:\\s*(.+)$", "i"));
    return m ? m[1].trim() : null;
  };
  const pedidos = [];
  let cur = {};
  String(texto || "").split(/\r?\n/).forEach(l => {
    let v;
    if ((v = campo(l, "sector")) != null) {
      if (cur.producto) { pedidos.push(cur); cur = {}; }
      cur.sector = v;
    } else if ((v = campo(l, "solicitante")) != null) {
      cur.solicitante = v;
    } else if ((v = campo(l, "producto")) != null) {
      if (cur.producto) { pedidos.push(cur); cur = { sector: cur.sector, solicitante: cur.solicitante }; }
      cur.producto = v;
    } else if ((v = campo(l, "cantidad")) != null) {
      cur.cantidad = parseInt(String(v).replace(/\D/g, "")) || 1;
    } else if ((v = campo(l, "monto")) != null) {
      cur.monto = parseFloat(String(v).replace(/[^\d.,]/g, "").replace(/\./g, "").replace(",", ".")) || 0;
    }
  });
  if (cur.producto) pedidos.push(cur);
  return pedidos;
}

module.exports = { parsearPedidos };
