/* =========================================================
   ABASTO GFL · Sistema de Control Interno
   Módulo 1: Acceso, roles (Dueño / Cajero), tasa BCV y estructura base
   ========================================================= */

/* ---------------------------------------------------------
   1) CONFIGURACIÓN DE FIREBASE
   Pega aquí los datos de tu proyecto (Consola Firebase →
   Configuración del proyecto → Tus apps → App web).
   Mientras diga "TU_API_KEY", el sistema funciona en
   MODO PRUEBA LOCAL (los datos quedan en este navegador).
   --------------------------------------------------------- */
const firebaseConfig = {
  apiKey: "AIzaSyB3qBhvUeboSJQs7akGHXBeKTIC6HHgqss",
  authDomain: "abasto-gfl.firebaseapp.com",
  projectId: "abasto-gfl",
  storageBucket: "abasto-gfl.firebasestorage.app",
  messagingSenderId: "398191924194",
  appId: "1:398191924194:web:d9e12587828dc265b55fbb"
};

const MODO_LOCAL = firebaseConfig.apiKey.startsWith("TU_");

/* ---------------------------------------------------------
   2) UTILIDADES
   --------------------------------------------------------- */
const $ = (s, c = document) => c.querySelector(s);
const $$ = (s, c = document) => [...c.querySelectorAll(s)];

function hoyISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fechaCorta(iso) {
  if (!iso) return "";
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}
const numVenta = n => String(n).padStart(6, "0");
const fmtBs = n => "Bs " + Number(n || 0).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtUsd = n => "$ " + Number(n || 0).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toast(msg, error = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast ver" + (error ? " error" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = "toast"), 3200);
}

function traducirError(e) {
  const c = e && (e.code || e.message || "");
  const mapa = {
    "auth/invalid-email": "El correo no es válido.",
    "auth/user-not-found": "No existe una cuenta con ese correo.",
    "auth/wrong-password": "Clave incorrecta.",
    "auth/invalid-credential": "Correo o clave incorrectos.",
    "auth/invalid-login-credentials": "Correo o clave incorrectos.",
    "auth/email-already-in-use": "Ese correo ya está registrado.",
    "auth/weak-password": "La clave debe tener al menos 6 caracteres.",
    "auth/too-many-requests": "Demasiados intentos. Espera unos minutos.",
    "auth/network-request-failed": "Sin conexión a internet.",
    "permission-denied": "No tienes permiso para esta acción."
  };
  for (const k in mapa) if (c.includes(k)) return mapa[k];
  return "Ocurrió un error: " + c;
}

/* ---------------------------------------------------------
   3) CAPA DE DATOS
   Mismas funciones para Firebase y para el modo local,
   así el resto del sistema no cambia.
   --------------------------------------------------------- */
function crearStoreFirebase() {
  firebase.initializeApp(firebaseConfig);
  const auth = firebase.auth();
  const db = firebase.firestore();
  db.enablePersistence({ synchronizeTabs: true }).catch(() => {});
  const ahora = () => firebase.firestore.FieldValue.serverTimestamp();

  return {
    onAuth: cb => auth.onAuthStateChanged(u => cb(u ? { uid: u.uid, email: u.email } : null)),

    async registrar(nombre, email, clave) {
      const cred = await auth.createUserWithEmailAndPassword(email, clave);
      const uid = cred.user.uid;
      const sisRef = db.doc("config/sistema");
      // El primer usuario en registrarse queda como Dueño (transacción para evitar dos dueños)
      const esPrimero = await db.runTransaction(async tx => {
        const sis = await tx.get(sisRef);
        if (!sis.exists) {
          tx.set(sisRef, { ownerUid: uid, nombreAbasto: "Abasto GFL", creado: ahora() });
          return true;
        }
        return false;
      });
      const perfil = {
        nombre, email,
        rol: esPrimero ? "dueno" : "cajero",
        activo: esPrimero,
        creado: ahora()
      };
      await db.doc(`usuarios/${uid}`).set(perfil);
      return perfil;
    },
    ingresar: (email, clave) => auth.signInWithEmailAndPassword(email, clave),
    salir: () => auth.signOut(),
    recuperar: email => auth.sendPasswordResetEmail(email),

    async perfil(uid) {
      const s = await db.doc(`usuarios/${uid}`).get({ source: "server" }).catch(() => db.doc(`usuarios/${uid}`).get());
      return s.exists ? { uid, ...s.data() } : null;
    },
    async listarUsuarios() {
      const q = await db.collection("usuarios").get();
      return q.docs.map(d => ({ uid: d.id, ...d.data() }));
    },
    actualizarUsuario: (uid, datos) => db.doc(`usuarios/${uid}`).update(datos),

    async leerConfig() {
      const s = await db.doc("config/sistema").get();
      return s.exists ? s.data() : {};
    },
    guardarConfig: datos => db.doc("config/sistema").set(datos, { merge: true }),

    escucharTasa: cb => db.doc("config/tasa").onSnapshot(s => cb(s.exists ? s.data() : null)),
    async guardarTasa(valor, usuario) {
      const datos = { valor, fecha: hoyISO(), por: usuario, actualizado: ahora() };
      const lote = db.batch();
      lote.set(db.doc("config/tasa"), datos);
      lote.set(db.doc(`tasas/${datos.fecha}`), datos);
      await lote.commit();
    },
    async historialTasas() {
      const q = await db.collection("tasas").orderBy("fecha", "desc").limit(15).get();
      return q.docs.map(d => d.data());
    },

    /* ---- Productos e inventario ---- */
    escucharProductos: cb => db.collection("productos").onSnapshot(
      q => cb(q.docs.map(d => ({ id: d.id, ...d.data() }))),
      e => toast(traducirError(e), true)
    ),
    async crearProducto(datos, usuario) {
      const ref = db.collection("productos").doc();
      const lote = db.batch();
      lote.set(ref, { ...datos, creado: ahora(), actualizado: ahora() });
      if (datos.stock > 0) lote.set(db.collection("movimientos").doc(), {
        productoId: ref.id, codigo: datos.codigo, nombre: datos.nombre, tipo: "inicial",
        cantidad: datos.stock, antes: 0, despues: datos.stock, motivo: "Existencia inicial", usuario, fecha: ahora()
      });
      await lote.commit();
      return ref.id;
    },
    actualizarProducto: (id, datos) => db.doc(`productos/${id}`).update({ ...datos, actualizado: ahora() }),
    async ajustarStock(id, nuevo, motivo, usuario) {
      const ref = db.doc(`productos/${id}`);
      await db.runTransaction(async tx => {
        const p = (await tx.get(ref)).data();
        const antes = Number(p.stock || 0);
        tx.update(ref, { stock: nuevo, actualizado: ahora() });
        tx.set(db.collection("movimientos").doc(), {
          productoId: id, codigo: p.codigo, nombre: p.nombre, tipo: "ajuste",
          cantidad: +(nuevo - antes).toFixed(3), antes, despues: nuevo, motivo, usuario, fecha: ahora()
        });
      });
    },
    async movimientos(id) {
      const q = await db.collection("movimientos").where("productoId", "==", id).get();
      return q.docs.map(d => { const m = d.data(); return { ...m, _t: m.fecha?.toMillis?.() || Date.now() }; })
                   .sort((a, b) => b._t - a._t);
    },

    /* ---- Ventas ---- */
    // Guarda la venta, descuenta el inventario y deja el kárdex en una sola operación.
    // Usa un correlativo (#000001, #000002…) para la auditoría.
    async registrarVenta(v) {
      const contRef = db.doc("config/contadores");
      const ventaRef = db.collection("ventas").doc();
      const prodRefs = v.items.map(i => db.doc(`productos/${i.productoId}`));
      let numero;
      await db.runTransaction(async tx => {
        const c = await tx.get(contRef);
        const snaps = await Promise.all(prodRefs.map(r => tx.get(r)));
        numero = (c.exists ? Number(c.data().ventas || 0) : 0) + 1;
        tx.set(contRef, { ventas: numero }, { merge: true });
        snaps.forEach((snap, k) => {
          const it = v.items[k];
          const antes = Number(snap.data()?.stock || 0);
          const despues = +(antes - it.cantidad).toFixed(3);
          tx.update(prodRefs[k], { stock: despues, actualizado: ahora() });
          tx.set(db.collection("movimientos").doc(), {
            productoId: it.productoId, codigo: it.codigo, nombre: it.nombre, tipo: "venta",
            cantidad: -it.cantidad, antes, despues, motivo: "Venta #" + numVenta(numero), usuario: v.cajero, fecha: ahora()
          });
        });
        tx.set(ventaRef, { ...v, numero, fecha: ahora() });
      });
      return numero;
    },
    async ventasDelDia(dia, cajeroUid = null) {
      let q = db.collection("ventas").where("dia", "==", dia);
      if (cajeroUid) q = q.where("cajeroUid", "==", cajeroUid);
      const r = await q.get();
      return r.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    async ventasRango(desde, hasta) {
      const r = await db.collection("ventas").where("dia", ">=", desde).where("dia", "<=", hasta).get();
      return r.docs.map(d => ({ id: d.id, ...d.data(), _t: d.data().fecha?.toMillis?.() || 0 }));
    },
    // Anula una venta: la marca como anulada y devuelve la mercancía al inventario
    async anularVenta(id, motivo, usuario) {
      const vRef = db.doc(`ventas/${id}`);
      await db.runTransaction(async tx => {
        const v = (await tx.get(vRef)).data();
        if (!v || v.anulada) throw new Error("La venta ya está anulada");
        const refs = v.items.map(i => db.doc(`productos/${i.productoId}`));
        const snaps = await Promise.all(refs.map(r => tx.get(r)));
        snaps.forEach((snap, k) => {
          if (!snap.exists) return;
          const it = v.items[k], antes = Number(snap.data().stock || 0), despues = +(antes + it.cantidad).toFixed(3);
          tx.update(refs[k], { stock: despues, actualizado: ahora() });
          tx.set(db.collection("movimientos").doc(), { productoId: it.productoId, codigo: it.codigo, nombre: it.nombre,
            tipo: "anulacion", cantidad: it.cantidad, antes, despues, motivo: `Anulación venta #${numVenta(v.numero)}: ${motivo}`, usuario, fecha: ahora() });
        });
        tx.update(vRef, { anulada: true, anuladaPor: usuario, motivoAnulacion: motivo, anuladaEl: ahora() });
      });
    },

    /* ---- Proveedores ---- */
    escucharProveedores: cb => db.collection("proveedores").onSnapshot(
      q => cb(q.docs.map(d => ({ id: d.id, ...d.data() }))), e => toast(traducirError(e), true)),
    crearProveedor: async datos => (await db.collection("proveedores").add({ ...datos, activo: true, creado: ahora() })).id,
    actualizarProveedor: (id, datos) => db.doc(`proveedores/${id}`).update(datos),

    /* ---- Compras ---- */
    // Suma la mercancía al inventario, actualiza el costo de cada producto y guarda la factura
    async registrarCompra(c) {
      const cRef = db.collection("compras").doc();
      const refs = c.items.map(i => db.doc(`productos/${i.productoId}`));
      await db.runTransaction(async tx => {
        const snaps = await Promise.all(refs.map(r => tx.get(r)));
        snaps.forEach((snap, k) => {
          const it = c.items[k], antes = Number(snap.data()?.stock || 0), despues = +(antes + it.cantidad).toFixed(3);
          tx.update(refs[k], { stock: despues, costoUsd: it.costoUsd, iva: it.iva, actualizado: ahora() });
          tx.set(db.collection("movimientos").doc(), { productoId: it.productoId, codigo: it.codigo, nombre: it.nombre,
            tipo: "compra", cantidad: it.cantidad, antes, despues, motivo: `Compra ${c.proveedorNombre} · Fact. ${c.factura || "s/n"}`, usuario: c.usuario, fecha: ahora() });
        });
        tx.set(cRef, { ...c, creado: ahora() });
      });
      return cRef.id;
    },
    async comprasRango(desde, hasta) {
      const r = await db.collection("compras").where("dia", ">=", desde).where("dia", "<=", hasta).get();
      return r.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    async comprasPendientes() {
      const r = await db.collection("compras").where("saldoUsd", ">", 0).get();
      return r.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    async comprasDeProveedor(provId) {
      const r = await db.collection("compras").where("proveedorId", "==", provId).get();
      return r.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    async abonarCompra(id, abono) {
      const ref = db.doc(`compras/${id}`);
      await db.runTransaction(async tx => {
        const c = (await tx.get(ref)).data();
        const saldo = Math.max(0, red2(c.saldoUsd - abono.montoUsd));
        tx.update(ref, { saldoUsd: saldo, abonos: [...(c.abonos || []), abono] });
      });
    },

    /* ---- Autoconsumo y mermas ---- */
    async registrarSalida(sal) {
      const pRef = db.doc(`productos/${sal.productoId}`), sRef = db.collection("salidas").doc();
      await db.runTransaction(async tx => {
        const p = (await tx.get(pRef)).data();
        const antes = Number(p.stock || 0), despues = +(antes - sal.cantidad).toFixed(3);
        tx.update(pRef, { stock: despues, actualizado: ahora() });
        tx.set(db.collection("movimientos").doc(), { productoId: sal.productoId, codigo: sal.codigo, nombre: sal.nombre,
          tipo: sal.tipo, cantidad: -sal.cantidad, antes, despues, motivo: TIPOS_SALIDA[sal.tipo].nombre + (sal.nota ? ": " + sal.nota : ""), usuario: sal.usuario, fecha: ahora() });
        tx.set(sRef, { ...sal, fecha: ahora() });
      });
    },
    async salidasRango(desde, hasta) {
      const r = await db.collection("salidas").where("dia", ">=", desde).where("dia", "<=", hasta).get();
      return r.docs.map(d => ({ id: d.id, ...d.data(), _t: d.data().fecha?.toMillis?.() || 0 }));
    }
  };
}

function crearStoreLocal() {
  const K = "abastoGFL_";
  const leer = (k, def) => { try { return JSON.parse(localStorage.getItem(K + k)) ?? def; } catch { return def; } };
  const guardar = (k, v) => localStorage.setItem(K + k, JSON.stringify(v));
  const hash = async t => {
    if (!window.crypto?.subtle) return btoa(t);
    const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
    return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
  };
  let oyenteAuth = null;
  const oyentesTasa = [];
  const sesion = () => leer("sesion", null);
  const avisar = () => oyenteAuth && oyenteAuth(sesion());
  const err = code => Object.assign(new Error(code), { code });
  const oyentesProd = [], oyentesProv = [];
  const listaProd = () => Object.entries(leer("productos", {})).map(([id, p]) => ({ id, ...p }));
  const notificarProd = () => oyentesProd.forEach(cb => cb(listaProd()));
  const agregarMov = m => { const l = leer("movimientos", []); l.push({ ...m, fecha: Date.now() }); guardar("movimientos", l); };

  return {
    onAuth(cb) { oyenteAuth = cb; setTimeout(avisar, 300); },

    async registrar(nombre, email, clave) {
      email = email.trim().toLowerCase();
      const usuarios = leer("usuarios", {});
      if (Object.values(usuarios).some(u => u.email === email)) throw err("auth/email-already-in-use");
      if (clave.length < 6) throw err("auth/weak-password");
      const uid = "u" + Date.now();
      const esPrimero = Object.keys(usuarios).length === 0;
      usuarios[uid] = { nombre, email, clave: await hash(clave), rol: esPrimero ? "dueno" : "cajero", activo: esPrimero, creado: Date.now() };
      guardar("usuarios", usuarios);
      if (esPrimero) guardar("sistema", { ownerUid: uid, nombreAbasto: "Abasto GFL" });
      guardar("sesion", { uid, email });
      avisar();
      return usuarios[uid];
    },
    async ingresar(email, clave) {
      email = email.trim().toLowerCase();
      const usuarios = leer("usuarios", {});
      const par = Object.entries(usuarios).find(([, u]) => u.email === email);
      if (!par || par[1].clave !== await hash(clave)) throw err("auth/invalid-credential");
      guardar("sesion", { uid: par[0], email });
      avisar();
    },
    async salir() { localStorage.removeItem(K + "sesion"); avisar(); },
    async recuperar() { throw err("En modo prueba local no se envían correos. Configura Firebase."); },

    async perfil(uid) {
      const u = leer("usuarios", {})[uid];
      if (!u) return null;
      const { clave, ...resto } = u;
      return { uid, ...resto };
    },
    async listarUsuarios() {
      return Object.entries(leer("usuarios", {})).map(([uid, u]) => { const { clave, ...r } = u; return { uid, ...r }; });
    },
    async actualizarUsuario(uid, datos) {
      const usuarios = leer("usuarios", {});
      Object.assign(usuarios[uid], datos);
      guardar("usuarios", usuarios);
    },

    async leerConfig() { return leer("sistema", {}); },
    async guardarConfig(datos) { guardar("sistema", { ...leer("sistema", {}), ...datos }); },

    escucharTasa(cb) { oyentesTasa.push(cb); cb(leer("tasa", null)); return () => oyentesTasa.splice(oyentesTasa.indexOf(cb), 1); },
    async guardarTasa(valor, usuario) {
      const datos = { valor, fecha: hoyISO(), por: usuario };
      guardar("tasa", datos);
      const hist = leer("tasas", {});
      hist[datos.fecha] = datos;
      guardar("tasas", hist);
      oyentesTasa.forEach(cb => cb(datos));
    },
    async historialTasas() {
      return Object.values(leer("tasas", {})).sort((a, b) => b.fecha.localeCompare(a.fecha)).slice(0, 15);
    },

    /* ---- Productos e inventario ---- */
    escucharProductos(cb) { oyentesProd.push(cb); cb(listaProd()); return () => oyentesProd.splice(oyentesProd.indexOf(cb), 1); },
    async crearProducto(datos, usuario) {
      const ps = leer("productos", {});
      const id = "p" + Date.now() + Math.random().toString(36).slice(2, 6);
      ps[id] = { ...datos, creado: Date.now(), actualizado: Date.now() };
      guardar("productos", ps);
      if (datos.stock > 0) agregarMov({ productoId: id, codigo: datos.codigo, nombre: datos.nombre, tipo: "inicial",
        cantidad: datos.stock, antes: 0, despues: datos.stock, motivo: "Existencia inicial", usuario });
      notificarProd();
      return id;
    },
    async actualizarProducto(id, datos) {
      const ps = leer("productos", {});
      Object.assign(ps[id], datos, { actualizado: Date.now() });
      guardar("productos", ps);
      notificarProd();
    },
    async ajustarStock(id, nuevo, motivo, usuario) {
      const ps = leer("productos", {});
      const p = ps[id], antes = Number(p.stock || 0);
      p.stock = nuevo; p.actualizado = Date.now();
      guardar("productos", ps);
      agregarMov({ productoId: id, codigo: p.codigo, nombre: p.nombre, tipo: "ajuste",
        cantidad: +(nuevo - antes).toFixed(3), antes, despues: nuevo, motivo, usuario });
      notificarProd();
    },
    async movimientos(id) {
      return leer("movimientos", []).filter(m => m.productoId === id).map(m => ({ ...m, _t: m.fecha })).sort((a, b) => b._t - a._t);
    },

    /* ---- Ventas ---- */
    async registrarVenta(v) {
      const numero = Number(leer("contadorVentas", 0)) + 1;
      guardar("contadorVentas", numero);
      const ps = leer("productos", {});
      v.items.forEach(it => {
        const p = ps[it.productoId]; if (!p) return;
        const antes = Number(p.stock || 0), despues = +(antes - it.cantidad).toFixed(3);
        p.stock = despues; p.actualizado = Date.now();
        agregarMov({ productoId: it.productoId, codigo: it.codigo, nombre: it.nombre, tipo: "venta",
          cantidad: -it.cantidad, antes, despues, motivo: "Venta #" + numVenta(numero), usuario: v.cajero });
      });
      guardar("productos", ps);
      const ventas = leer("ventas", []);
      ventas.push({ ...v, id: "v" + Date.now(), numero, fecha: Date.now() });
      guardar("ventas", ventas);
      notificarProd();
      return numero;
    },
    async ventasDelDia(dia, cajeroUid = null) {
      return leer("ventas", []).filter(v => v.dia === dia && (!cajeroUid || v.cajeroUid === cajeroUid));
    },
    async ventasRango(desde, hasta) {
      return leer("ventas", []).filter(v => v.dia >= desde && v.dia <= hasta).map(v => ({ ...v, _t: v.fecha }));
    },
    async anularVenta(id, motivo, usuario) {
      const ventas = leer("ventas", []), v = ventas.find(x => x.id === id);
      if (!v || v.anulada) throw new Error("La venta ya está anulada");
      const ps = leer("productos", {});
      v.items.forEach(it => {
        const p = ps[it.productoId]; if (!p) return;
        const antes = Number(p.stock || 0), despues = +(antes + it.cantidad).toFixed(3);
        p.stock = despues;
        agregarMov({ productoId: it.productoId, codigo: it.codigo, nombre: it.nombre, tipo: "anulacion", cantidad: it.cantidad,
          antes, despues, motivo: `Anulación venta #${numVenta(v.numero)}: ${motivo}`, usuario });
      });
      Object.assign(v, { anulada: true, anuladaPor: usuario, motivoAnulacion: motivo, anuladaEl: Date.now() });
      guardar("productos", ps); guardar("ventas", ventas); notificarProd();
    },

    /* ---- Proveedores ---- */
    escucharProveedores(cb) {
      oyentesProv.push(cb); cb(leer("proveedores", []));
      return () => oyentesProv.splice(oyentesProv.indexOf(cb), 1);
    },
    async crearProveedor(datos) {
      const l = leer("proveedores", []), id = "pr" + Date.now();
      l.push({ id, ...datos, activo: true, creado: Date.now() }); guardar("proveedores", l);
      oyentesProv.forEach(cb => cb(l)); return id;
    },
    async actualizarProveedor(id, datos) {
      const l = leer("proveedores", []); Object.assign(l.find(x => x.id === id), datos);
      guardar("proveedores", l); oyentesProv.forEach(cb => cb(l));
    },

    /* ---- Compras ---- */
    async registrarCompra(c) {
      const ps = leer("productos", {});
      c.items.forEach(it => {
        const p = ps[it.productoId]; if (!p) return;
        const antes = Number(p.stock || 0), despues = +(antes + it.cantidad).toFixed(3);
        Object.assign(p, { stock: despues, costoUsd: it.costoUsd, iva: it.iva, actualizado: Date.now() });
        agregarMov({ productoId: it.productoId, codigo: it.codigo, nombre: it.nombre, tipo: "compra", cantidad: it.cantidad,
          antes, despues, motivo: `Compra ${c.proveedorNombre} · Fact. ${c.factura || "s/n"}`, usuario: c.usuario });
      });
      guardar("productos", ps);
      const l = leer("compras", []), id = "c" + Date.now();
      l.push({ id, ...c, creado: Date.now() }); guardar("compras", l);
      notificarProd(); return id;
    },
    async comprasRango(desde, hasta) { return leer("compras", []).filter(c => c.dia >= desde && c.dia <= hasta); },
    async comprasPendientes() { return leer("compras", []).filter(c => c.saldoUsd > 0); },
    async comprasDeProveedor(provId) { return leer("compras", []).filter(c => c.proveedorId === provId); },
    async abonarCompra(id, abono) {
      const l = leer("compras", []), c = l.find(x => x.id === id);
      c.saldoUsd = Math.max(0, red2(c.saldoUsd - abono.montoUsd));
      c.abonos = [...(c.abonos || []), abono]; guardar("compras", l);
    },

    /* ---- Autoconsumo y mermas ---- */
    async registrarSalida(sal) {
      const ps = leer("productos", {}), p = ps[sal.productoId];
      const antes = Number(p.stock || 0), despues = +(antes - sal.cantidad).toFixed(3);
      p.stock = despues; guardar("productos", ps);
      agregarMov({ productoId: sal.productoId, codigo: sal.codigo, nombre: sal.nombre, tipo: sal.tipo, cantidad: -sal.cantidad,
        antes, despues, motivo: TIPOS_SALIDA[sal.tipo].nombre + (sal.nota ? ": " + sal.nota : ""), usuario: sal.usuario });
      const l = leer("salidas", []); l.push({ id: "s" + Date.now(), ...sal, fecha: Date.now() }); guardar("salidas", l);
      notificarProd();
    },
    async salidasRango(desde, hasta) {
      return leer("salidas", []).filter(x => x.dia >= desde && x.dia <= hasta).map(x => ({ ...x, _t: x.fecha }));
    }
  };
}

const Store = MODO_LOCAL ? crearStoreLocal() : crearStoreFirebase();

/* ---------------------------------------------------------
   4) ESTADO GLOBAL
   --------------------------------------------------------- */
const Estado = {
  usuario: null,   // perfil completo { uid, nombre, email, rol, activo }
  tasa: null,      // { valor, fecha, por }
  config: {},      // datos del abasto, % IVA, categorías
  productos: [],   // catálogo en tiempo real
  proveedores: [], // directorio de proveedores (solo dueño)
  vista: "inicio",
  repintar: null   // función que refresca la vista abierta cuando cambian los datos
};
const esDueno = () => Estado.usuario?.rol === "dueno";

/* ---------------------------------------------------------
   4.1) CÁLCULOS DE PRECIOS
   - El costo se guarda en dólares SIN IVA (como viene en la factura).
   - Si el producto grava IVA, el costo real = costo × (1 + IVA).
   - Costo en Bs = costo real $ × tasa BCV del día (sube cuando sube la tasa).
   - El precio de venta se guarda en Bs: es el que ve el punto de venta.
   - % ganancia = (precio Bs − costo Bs) ÷ costo Bs × 100  (ganancia sobre el costo)
   --------------------------------------------------------- */
const CATEGORIAS_BASE = ["Víveres", "Charcutería", "Verduras"];
const categorias = () => (Estado.config.categorias?.length ? Estado.config.categorias : CATEGORIAS_BASE);
const pctIva = () => Number(Estado.config.iva ?? 16);
const tasaHoy = () => Number(Estado.tasa?.valor || 0);
const red2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const costoUsdReal = p => Number(p.costoUsd || 0) * (p.iva ? 1 + pctIva() / 100 : 1);
const costoBs = p => tasaHoy() ? costoUsdReal(p) * tasaHoy() : null;
function margen(p) {
  const c = costoBs(p);
  if (c == null || c <= 0) return null;
  return (Number(p.precioBs || 0) - c) / c * 100;
}
const precioDesdeMargen = (p, pct) => red2(costoBs(p) * (1 + pct / 100));
const stockBajo = p => Number(p.stock || 0) <= Number(p.stockMin || 0);
const fmtCant = (n, u) => u === "kg"
  ? Number(n || 0).toLocaleString("es-VE", { minimumFractionDigits: 3, maximumFractionDigits: 3 }) + " kg"
  : Number(n || 0).toLocaleString("es-VE", { maximumFractionDigits: 0 }) + " und";
const fmtPct = n => n == null ? "—" : (n > 0 ? "+" : "") + n.toFixed(1) + " %";
const ordenarCodigo = (a, b) => String(a.codigo).localeCompare(String(b.codigo), undefined, { numeric: true });
const normal = t => String(t || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

function filtrarProductos({ texto = "", cat = "" } = {}) {
  const t = normal(texto);
  return Estado.productos
    .filter(p => p.activo !== false)
    .filter(p => (!cat || p.categoria === cat) && (!t || normal(p.codigo).includes(t) || normal(p.nombre).includes(t)))
    .sort(ordenarCodigo);
}
const buscarPorCodigo = c => Estado.productos.find(p => normal(p.codigo) === normal(c));

function siguienteCodigo() {
  const nums = Estado.productos.map(p => String(p.codigo)).filter(c => /^\d{1,5}$/.test(c)).map(Number);
  return String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, "0");
}


/* ---------------------------------------------------------
   4.2) FECHAS, PERÍODOS Y HERRAMIENTAS COMPARTIDAS
   --------------------------------------------------------- */
const TIPOS_SALIDA = {
  autoconsumo: { nombre: "Autoconsumo",    ico: "🍽️", color: "lavanda" },
  merma:       { nombre: "Merma / dañado", ico: "🗑️", color: "rosa" },
  vencido:     { nombre: "Vencido",        ico: "⏰", color: "amarillo" }
};
const isoDe = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function rangoPreset(p) {
  const h = new Date(), d = new Date(h);
  if (p === "ayer") { d.setDate(h.getDate() - 1); return [isoDe(d), isoDe(d)]; }
  if (p === "semana") { d.setDate(h.getDate() - ((h.getDay() + 6) % 7)); return [isoDe(d), isoDe(h)]; }
  if (p === "mes") return [isoDe(new Date(h.getFullYear(), h.getMonth(), 1)), isoDe(h)];
  if (p === "mesPasado") return [isoDe(new Date(h.getFullYear(), h.getMonth() - 1, 1)), isoDe(new Date(h.getFullYear(), h.getMonth(), 0))];
  return [isoDe(h), isoDe(h)];
}
const nuevoPeriodo = preset => { const [desde, hasta] = rangoPreset(preset); return { preset, desde, hasta }; };
const textoPeriodo = f => f.desde === f.hasta ? fechaCorta(f.desde) : `${fechaCorta(f.desde)} al ${fechaCorta(f.hasta)}`;
const horaDe = t => t ? new Date(t).toLocaleTimeString("es-VE", { hour: "2-digit", minute: "2-digit" }) : "";
const fmtNum = (n, d = 2) => Number(n || 0).toLocaleString("es-VE", { minimumFractionDigits: d, maximumFractionDigits: d });
const sumar = (l, f) => l.reduce((a, x) => a + (Number(f(x)) || 0), 0);

function htmlPeriodo(f) {
  const ops = [["hoy", "Hoy"], ["ayer", "Ayer"], ["semana", "Esta semana"], ["mes", "Este mes"], ["mesPasado", "Mes pasado"]];
  return `<div class="periodo">
    ${ops.map(([k, t]) => `<button class="chip-btn ${f.preset === k ? "activo" : ""}" data-preset="${k}">${t}</button>`).join("")}
    <span class="periodo-fechas"><input type="date" data-desde value="${f.desde}"><span>a</span><input type="date" data-hasta value="${f.hasta}"></span>
  </div>`;
}
function conectarPeriodo(f, recargar) {
  $$("[data-preset]").forEach(b => b.onclick = () => { Object.assign(f, nuevoPeriodo(b.dataset.preset)); recargar(); });
  $("[data-desde]").onchange = e => { f.preset = ""; f.desde = e.target.value; if (f.hasta < f.desde) f.hasta = f.desde; recargar(); };
  $("[data-hasta]").onchange = e => { f.preset = ""; f.hasta = e.target.value; if (f.desde > f.hasta) f.desde = f.hasta; recargar(); };
}

// Buscador de productos con sugerencias y lector de código de barras (sin Enter)
function buscadorProducto(inp, box, alElegir, alNoExiste = null) {
  let sug = [], sel = 0, teclas = [], tScan = null;
  const elegir = p => { box.classList.add("oculto"); sug = []; inp.value = ""; teclas = []; alElegir(p); };
  const pintar = () => {
    box.classList.toggle("oculto", !sug.length);
    box.innerHTML = sug.map((p, i) => `<div class="sug ${i === sel ? "sel" : ""}" data-s="${i}"><span class="codigo">${esc(p.codigo)}</span> ${esc(p.nombre)} <b>${fmtCant(p.stock, p.unidad)}</b></div>`).join("");
    $$("[data-s]", box).forEach(d => d.onmousedown = e => { e.preventDefault(); elegir(sug[+d.dataset.s]); });
  };
  inp.oninput = () => {
    clearTimeout(tScan);
    const txt = inp.value.trim(), t = normal(txt);
    const esLector = teclas.length >= 4 && (teclas[teclas.length - 1] - teclas[0]) / (teclas.length - 1) < 35;
    if (esLector) { tScan = setTimeout(() => { const p = productoActivo(inp.value.trim()); if (p) elegir(p); }, 90); return; }
    sug = t.length >= 1 ? Estado.productos.filter(p => p.activo !== false && (normal(p.codigo).startsWith(t) || (t.length >= 2 && normal(p.nombre).includes(t)))).sort(ordenarCodigo).slice(0, 8) : [];
    sel = 0; pintar();
  };
  inp.onkeydown = e => {
    if (e.key.length === 1) { if (!inp.value) teclas = []; teclas.push(performance.now()); }
    if (e.key === "Enter") {
      e.preventDefault(); clearTimeout(tScan);
      const txt = inp.value.trim(); if (!txt) return;
      const p = productoActivo(txt) || sug[sel];
      if (p) elegir(p);
      else { sonar("error"); if (alNoExiste) alNoExiste(txt); else toast(`El código "${txt}" no existe`, true); }
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && sug.length) {
      e.preventDefault(); sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + sug.length) % sug.length; pintar();
    } else if (e.key === "Escape") { inp.value = ""; sug = []; pintar(); }
  };
  inp.onblur = () => setTimeout(() => box.classList.add("oculto"), 150);
}

// Exportar a Excel (CSV con ; y coma decimal)
function descargarCSV(nombre, filas) {
  const celda = v => typeof v === "number" ? String(v.toFixed(2)).replace(".", ",") : `"${String(v ?? "").replace(/"/g, '""')}"`;
  const txt = "﻿" + filas.map(f => f.map(celda).join(";")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([txt], { type: "text/csv;charset=utf-8" }));
  a.download = nombre + ".csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------------------------------------------------------
   5) MENÚ Y PERMISOS
   roles: qué rol puede ver cada módulo
   movil: aparece en la barra inferior del teléfono
   --------------------------------------------------------- */
const MODULOS = [
  { id: "inicio",      titulo: "Inicio",               ico: "🏠", color: "verde",    roles: ["dueno", "cajero"], movil: true },
  { id: "vender",      titulo: "Punto de Venta",       corto: "Vender",   ico: "🛒", color: "durazno",  roles: ["dueno", "cajero"], movil: true },
  { id: "inventario",  titulo: "Inventario",           ico: "📦", color: "cielo",    roles: ["dueno", "cajero"], movil: true },
  { id: "precios",     titulo: "Lista de Precios",     corto: "Precios",  ico: "🏷️", color: "verde",    roles: ["dueno"], movil: true, seccion: "Administración" },
  { id: "compras",     titulo: "Compras",              ico: "🧾", color: "amarillo", roles: ["dueno"] },
  { id: "proveedores", titulo: "Proveedores",          ico: "🚚", color: "lavanda",  roles: ["dueno"] },
  { id: "autoconsumo", titulo: "Autoconsumo y Mermas", ico: "🍽️", color: "rosa",     roles: ["dueno"] },
  { id: "reportes",    titulo: "Utilidad y Reportes",  corto: "Reportes", ico: "📊", color: "verde",    roles: ["dueno"] },
  { id: "usuarios",    titulo: "Usuarios",             ico: "👥", color: "lavanda",  roles: ["dueno"], seccion: "Sistema" },
  { id: "config",      titulo: "Configuración",        corto: "Ajustes",  ico: "⚙️", color: "amarillo", roles: ["dueno"], movil: true }
];
const modulosPermitidos = () => MODULOS.filter(m => m.roles.includes(Estado.usuario.rol));

function pintarMenu() {
  const menu = $("#menu");
  menu.innerHTML = modulosPermitidos().map(m => `
    ${m.seccion ? `<div class="menu-seccion">${m.seccion}</div>` : ""}
    <button class="menu-item ${m.id === Estado.vista ? "activo" : ""}" data-vista="${m.id}">
      <span class="ico" style="background:var(--${m.color === "verde" ? "verde-claro" : m.color})">${m.ico}</span>${m.titulo}
    </button>`).join("");

  const inferior = modulosPermitidos().filter(m => m.movil).slice(0, 5);
  $("#nav-inferior").innerHTML = inferior.map(m => `
    <button data-vista="${m.id}" class="${m.id === Estado.vista ? "activo" : ""}">
      <span class="ico">${m.ico}</span>${m.corto || m.titulo.split(" ")[0]}
    </button>`).join("");

  $$("[data-vista]").forEach(b => b.onclick = () => { irA(b.dataset.vista); cerrarMenuMovil(); });
}

function irA(id) {
  const m = modulosPermitidos().find(x => x.id === id) || modulosPermitidos()[0];
  Estado.vista = m.id;
  Estado.repintar = null;
  $("#titulo-vista").textContent = m.titulo;
  pintarMenu();
  (VISTAS[m.id] || vistaProxima)(m);
  window.scrollTo(0, 0);
}

/* ---------------------------------------------------------
   6) VISTAS
   --------------------------------------------------------- */
const VISTAS = {
  inicio: vistaInicio,
  vender: vistaVender,
  inventario: vistaInventario,
  precios: vistaPrecios,
  compras: vistaCompras,
  proveedores: vistaProveedores,
  autoconsumo: vistaAutoconsumo,
  reportes: vistaReportes,
  usuarios: vistaUsuarios,
  config: vistaConfig
};

function vistaInicio() {
  const n = Estado.usuario.nombre.split(" ")[0];
  const t = Estado.tasa;
  const avisoTasa = esDueno() && (!t || t.fecha !== hoyISO())
    ? `<div class="tarjeta" style="background:var(--amarillo);border:none;margin-bottom:18px">
         <b>⚠️ La tasa BCV no está actualizada hoy.</b> Actualízala antes de empezar a vender.
         <div style="margin-top:10px"><button class="btn btn-primario btn-sm" data-vista="config">Actualizar tasa</button></div>
       </div>` : "";

  $("#vista").innerHTML = `
    <div class="saludo">
      <h2>¡Hola, ${esc(n)}! 👋</h2>
      <p>${new Date().toLocaleDateString("es-VE", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</p>
    </div>
    ${avisoTasa}
    <div class="grid-tarjetas">
      <div class="tarjeta kpi verde"><small>${esDueno() ? "Ventas de hoy" : "Mis ventas de hoy"}</small><strong id="k-ventas">…</strong><span id="k-ventas-usd">&nbsp;</span></div>
      <div class="tarjeta kpi durazno"><small>Tickets de hoy</small><strong id="k-tickets">…</strong><span>ventas registradas</span></div>
      ${esDueno() ? `
      <div class="tarjeta kpi lavanda"><small>Utilidad bruta de hoy</small><strong id="k-util">…</strong><span id="k-util-usd">&nbsp;</span></div>
      <div class="tarjeta kpi rosa"><small>Stock bajo</small><strong>${Estado.productos.filter(p => p.activo !== false && stockBajo(p)).length}</strong><span>productos por reponer</span></div>
      <div class="tarjeta kpi amarillo"><small>Precios en pérdida</small><strong>${Estado.productos.filter(p => p.activo !== false && (margen(p) ?? 0) < 0).length}</strong><span>revisar en Lista de Precios</span></div>` : ""}
      <div class="tarjeta kpi cielo"><small>Tasa BCV</small><strong>${t ? "Bs " + Number(t.valor).toFixed(2) : "—"}</strong><span>${t ? fechaCorta(t.fecha) : "sin registrar"}</span></div>
    </div>
    <div class="tarjeta">
      <h3>Accesos rápidos</h3>
      <div class="acciones">
        <button class="btn btn-primario" data-vista="vender">🛒 Nueva venta</button>
        <button class="btn btn-secundario" data-vista="inventario">📦 Ver inventario</button>
        ${esDueno() ? `<button class="btn btn-secundario" data-vista="compras">🧾 Registrar compra</button>
        <button class="btn btn-secundario" data-vista="autoconsumo">🍽️ Autoconsumo</button>` : ""}
      </div>
    </div>`;
  $$("#vista [data-vista]").forEach(b => b.onclick = () => irA(b.dataset.vista));

  // Resumen del día (el cajero solo ve sus propias ventas)
  Store.ventasDelDia(hoyISO(), esDueno() ? null : Estado.usuario.uid).then(vs => {
    if (Estado.vista !== "inicio" || !$("#k-ventas")) return;
    vs = vs.filter(v => !v.anulada);
    const tBs = vs.reduce((a, v) => a + v.totalBs, 0), uBs = vs.reduce((a, v) => a + (v.utilidadBs || 0), 0);
    $("#k-ventas").textContent = fmtBs(tBs);
    $("#k-ventas-usd").textContent = tasaHoy() ? fmtUsd(tBs / tasaHoy()) + " ref." : "";
    $("#k-tickets").textContent = vs.length;
    if ($("#k-util")) { $("#k-util").textContent = fmtBs(uBs); $("#k-util-usd").textContent = tasaHoy() ? fmtUsd(uBs / tasaHoy()) + " ref." : ""; }
  }).catch(() => { $("#k-ventas") && ($("#k-ventas").textContent = "—"); $("#k-tickets") && ($("#k-tickets").textContent = "—"); $("#k-util") && ($("#k-util").textContent = "—"); });
}

const DESCRIPCION_PROXIMA = {};

function vistaProxima(m) {
  const [txt, chips] = DESCRIPCION_PROXIMA[m.id] || ["Módulo en construcción.", []];
  $("#vista").innerHTML = `
    <div class="tarjeta proximo">
      <div class="emoji">${m.ico}</div>
      <h3>${m.titulo}</h3>
      <p>${txt}</p>
      <div class="chips">${chips.map(c => `<span class="chip">${c}</span>`).join("")}</div>
      <p style="margin-top:18px;font-size:13px">🔧 Este módulo se construye en las próximas entregas.</p>
    </div>`;
}

/* ---------- Ventana modal genérica ---------- */
function abrirModal(html, ancho = 560) {
  const m = $("#modal");
  $("#modal-caja").style.maxWidth = ancho + "px";
  $("#modal-caja").innerHTML = html;
  m.classList.remove("oculto");
  $$("[data-cerrar]", m).forEach(b => b.onclick = cerrarModal);
  setTimeout(() => $("#modal-caja input:not([readonly]), #modal-caja select")?.focus(), 50);
}
function cerrarModal() {
  $("#modal").classList.add("oculto"); $("#modal-caja").innerHTML = "";
  if (Estado.vista === "vender") $("#pos-codigo")?.focus();
}

/* ---------- Inventario (dueño: gestiona · cajero: consulta) ---------- */
const filtrosInv = { texto: "", cat: "", bajo: false };

function vistaInventario() {
  const d = esDueno();
  $("#vista").innerHTML = `
    <div class="grid-tarjetas" id="inv-kpis"></div>
    <div class="barra-herr">
      <input id="inv-buscar" class="buscador" placeholder="🔍 Código o nombre (puedes escanear)" autocomplete="off" value="${esc(filtrosInv.texto)}">
      <select id="inv-cat"><option value="">Todas las categorías</option>${categorias().map(c => `<option ${c === filtrosInv.cat ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
      <label class="check"><input type="checkbox" id="inv-bajo" ${filtrosInv.bajo ? "checked" : ""}> Solo stock bajo</label>
      ${d ? `<button class="btn btn-primario" id="btn-nuevo-prod">+ Nuevo producto</button>` : ""}
    </div>
    <div class="tarjeta sin-pad">
      <div class="tabla-wrap"><table class="tabla-inv">
        <thead><tr><th>Código</th><th>Producto</th><th>Categoría</th><th class="num">Existencia</th><th class="num">Precio Bs</th>${d ? "<th></th>" : ""}</tr></thead>
        <tbody id="inv-body"></tbody>
      </table></div>
    </div>`;

  const pintar = () => {
    const todos = filtrarProductos();
    const lista = filtrarProductos(filtrosInv).filter(p => !filtrosInv.bajo || stockBajo(p));
    $("#inv-kpis").innerHTML = `
      <div class="tarjeta kpi cielo"><small>Productos</small><strong>${todos.length}</strong><span>activos</span></div>
      <div class="tarjeta kpi rosa"><small>Stock bajo</small><strong>${todos.filter(stockBajo).length}</strong><span>por reponer</span></div>
      ${d ? `<div class="tarjeta kpi verde"><small>Inventario al costo</small><strong>${fmtUsd(todos.reduce((a, p) => a + costoUsdReal(p) * Math.max(0, p.stock || 0), 0))}</strong><span>${tasaHoy() ? fmtBs(todos.reduce((a, p) => a + (costoBs(p) || 0) * Math.max(0, p.stock || 0), 0)) : "registra la tasa"}</span></div>` : ""}`;
    $("#inv-body").innerHTML = lista.length ? lista.map(p => `
      <tr class="${stockBajo(p) ? "fila-baja" : ""}">
        <td><span class="codigo">${esc(p.codigo)}</span></td>
        <td><b>${esc(p.nombre)}</b><br><small class="sub">${p.unidad === "kg" ? "Por kilo" : "Por unidad"} · ${p.iva ? "IVA " + pctIva() + "%" : "Exento"}</small></td>
        <td>${esc(p.categoria)}</td>
        <td class="num"><b>${fmtCant(p.stock, p.unidad)}</b>${stockBajo(p) ? `<br><small class="alerta">⚠ mín. ${fmtCant(p.stockMin, p.unidad)}</small>` : ""}</td>
        <td class="num">${fmtBs(p.precioBs)}${p.unidad === "kg" ? "<small class='sub'>/kg</small>" : ""}</td>
        ${d ? `<td class="acciones-fila">
          <button class="btn btn-sm btn-secundario" data-editar="${p.id}" title="Editar">✏️</button>
          <button class="btn btn-sm btn-secundario" data-ajustar="${p.id}" title="Ajustar existencia">±</button>
          <button class="btn btn-sm btn-secundario" data-hist="${p.id}" title="Movimientos">📋</button>
        </td>` : ""}
      </tr>`).join("") : `<tr><td colspan="6" class="vacio">${Estado.productos.length ? "Sin resultados para esta búsqueda." : d ? "Aún no hay productos. Pulsa <b>+ Nuevo producto</b>." : "Aún no hay productos registrados."}</td></tr>`;

    $$("[data-editar]").forEach(b => b.onclick = () => modalProducto(b.dataset.editar));
    $$("[data-ajustar]").forEach(b => b.onclick = () => modalAjuste(b.dataset.ajustar));
    $$("[data-hist]").forEach(b => b.onclick = () => modalMovimientos(b.dataset.hist));
  };
  Estado.repintar = pintar;
  pintar();

  const buscar = $("#inv-buscar");
  buscar.oninput = () => { filtrosInv.texto = buscar.value; pintar(); };
  // Lector de código de barras: escribe el código y envía Enter
  buscar.onkeydown = e => {
    if (e.key !== "Enter") return;
    const p = buscarPorCodigo(buscar.value);
    if (!p) { if (d && buscar.value.trim() && confirm(`El código "${buscar.value.trim()}" no existe. ¿Registrar un producto nuevo con ese código?`)) modalProducto(null, buscar.value.trim()); return; }
    if (d) modalProducto(p.id); else toast(`${p.codigo} · ${p.nombre}: ${fmtCant(p.stock, p.unidad)} · ${fmtBs(p.precioBs)}`);
  };
  $("#inv-cat").onchange = e => { filtrosInv.cat = e.target.value; pintar(); };
  $("#inv-bajo").onchange = e => { filtrosInv.bajo = e.target.checked; pintar(); };
  if (d) $("#btn-nuevo-prod").onclick = () => modalProducto();
  buscar.focus();
}

/* ---------- Registrar / editar producto ---------- */
function modalProducto(id = null, codigoInicial = "", opts = {}) {
  const p = id ? Estado.productos.find(x => x.id === id) : null;
  const nuevo = !p;
  const v = p || { codigo: codigoInicial, nombre: "", categoria: categorias()[0], unidad: "und", iva: false, costoUsd: "", precioBs: "", stock: "", stockMin: Estado.config.stockMinimo ?? 5 };

  abrirModal(`
    <div class="modal-cab"><h3>${nuevo ? "Nuevo producto" : "Editar producto"}</h3><button class="btn-icono" data-cerrar>✕</button></div>
    <form id="form-prod">
      <div class="fila-form">
        <label>Código
          <div class="input-boton">
            <input id="p-codigo" required value="${esc(v.codigo)}" placeholder="Escanea o escribe (ej: 001)">
            <button type="button" class="btn btn-secundario btn-sm" id="p-gen" title="Código interno automático">Generar</button>
          </div>
        </label>
        <label>Categoría
          <select id="p-cat">${[...new Set([...categorias(), v.categoria].filter(Boolean))].map(c => `<option ${c === v.categoria ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
        </label>
      </div>
      <label>Nombre del producto<input id="p-nombre" required value="${esc(v.nombre)}" placeholder="Ej: QUESO BLANCO DURO"></label>

      <div class="fila-form">
        <div class="campo"><span class="etq">Se vende por</span>
          <div class="segmento">
            <label><input type="radio" name="p-unidad" value="und" ${v.unidad !== "kg" ? "checked" : ""}><span>Unidad</span></label>
            <label><input type="radio" name="p-unidad" value="kg" ${v.unidad === "kg" ? "checked" : ""}><span>Kilogramo</span></label>
          </div>
        </div>
        <div class="campo"><span class="etq">IVA en la compra</span>
          <div class="segmento">
            <label><input type="radio" name="p-iva" value="0" ${!v.iva ? "checked" : ""}><span>Exento</span></label>
            <label><input type="radio" name="p-iva" value="1" ${v.iva ? "checked" : ""}><span>Grava ${pctIva()}%</span></label>
          </div>
        </div>
      </div>

      <div class="fila-form">
        <label>Costo en $ <small>(sin IVA, como en la factura)</small><input type="number" id="p-costo" step="0.0001" min="0" required value="${v.costoUsd}"></label>
        <label>Precio de venta Bs <span class="u-txt"></span><input type="number" id="p-precio" step="0.01" min="0" required value="${v.precioBs}"></label>
        <label>% Ganancia<input type="number" id="p-margen" step="0.1" placeholder="—"></label>
      </div>
      <div class="resumen-costo" id="p-resumen"></div>

      <div class="fila-form">
        ${nuevo && !opts.sinStock ? `<label>Existencia inicial <span class="u-txt"></span><input type="number" id="p-stock" step="0.001" min="0" value="${v.stock}" placeholder="0"></label>` : ""}
        <label>Stock mínimo (alerta) <span class="u-txt"></span><input type="number" id="p-min" step="0.001" min="0" value="${v.stockMin}"></label>
      </div>

      <div class="acciones modal-pie">
        ${!nuevo ? `<button type="button" class="btn btn-peligro" id="p-desactivar">${p.activo === false ? "Reactivar" : "Desactivar"}</button>` : ""}
        <span style="flex:1"></span>
        <button type="button" class="btn btn-fantasma" data-cerrar>Cancelar</button>
        <button class="btn btn-primario">${nuevo ? "Registrar producto" : "Guardar cambios"}</button>
      </div>
    </form>`, 640);

  const leerForm = () => ({
    codigo: $("#p-codigo").value.trim(),
    nombre: $("#p-nombre").value.trim().toUpperCase(),
    categoria: $("#p-cat").value,
    unidad: $("[name=p-unidad]:checked").value,
    iva: $("[name=p-iva]:checked").value === "1",
    costoUsd: Number($("#p-costo").value || 0),
    precioBs: red2($("#p-precio").value || 0),
    stockMin: Number($("#p-min").value || 0)
  });

  const resumen = () => {
    const f = leerForm();
    $$(".u-txt").forEach(s => s.textContent = f.unidad === "kg" ? "(por kg)" : "");
    const cB = costoBs(f), m = margen(f);
    $("#p-resumen").innerHTML = `
      <div><small>Costo con IVA</small><b>${fmtUsd(costoUsdReal(f))}</b></div>
      <div><small>Costo en Bs hoy</small><b>${cB == null ? "Sin tasa" : fmtBs(cB)}</b></div>
      <div><small>Precio ref. $</small><b>${tasaHoy() ? fmtUsd(f.precioBs / tasaHoy()) : "—"}</b></div>
      <div class="${m != null && m < 0 ? "neg" : ""}"><small>Ganancia</small><b>${fmtPct(m)}</b></div>`;
    return m;
  };
  const syncMargen = () => { const m = resumen(); if (document.activeElement !== $("#p-margen")) $("#p-margen").value = m == null ? "" : m.toFixed(1); };
  syncMargen();

  ["#p-costo", "#p-precio"].forEach(s => $(s).oninput = syncMargen);
  $$("[name=p-iva], [name=p-unidad]").forEach(r => r.onchange = syncMargen);
  $("#p-margen").oninput = () => {
    const f = leerForm(), pct = parseFloat($("#p-margen").value);
    if (!tasaHoy()) return toast("Registra primero la tasa BCV del día", true);
    if (!isNaN(pct) && costoBs(f) > 0) { $("#p-precio").value = precioDesdeMargen(f, pct).toFixed(2); resumen(); }
  };
  $("#p-gen").onclick = () => { $("#p-codigo").value = siguienteCodigo(); $("#p-nombre").focus(); };
  $("#p-codigo").onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); $("#p-nombre").focus(); } };

  if (!nuevo) $("#p-desactivar").onclick = async () => {
    const activar = p.activo === false;
    if (!activar && !confirm(`¿Desactivar "${p.nombre}"? Dejará de aparecer en inventario y punto de venta (su historial se conserva).`)) return;
    try { await Store.actualizarProducto(p.id, { activo: activar }); toast(activar ? "Producto reactivado" : "Producto desactivado"); cerrarModal(); }
    catch (e) { toast(traducirError(e), true); }
  };

  $("#form-prod").onsubmit = async e => {
    e.preventDefault();
    const f = leerForm();
    if (!f.codigo || !f.nombre) return toast("Código y nombre son obligatorios", true);
    const dup = Estado.productos.find(x => normal(x.codigo) === normal(f.codigo) && x.id !== id);
    if (dup) return toast(`El código ${f.codigo} ya pertenece a "${dup.nombre}"`, true);
    const btn = e.submitter; btn.disabled = true;
    try {
      if (nuevo) {
        const datos = { ...f, stock: Number($("#p-stock")?.value || 0), activo: true };
        const nuevoId = await Store.crearProducto(datos, Estado.usuario.nombre);
        toast("Producto registrado ✔");
        if (opts.alCrear) setTimeout(() => opts.alCrear({ id: nuevoId, ...datos }), 50);
      } else {
        await Store.actualizarProducto(id, f);
        toast("Cambios guardados ✔");
      }
      cerrarModal();
    } catch (err) { toast(traducirError(err), true); btn.disabled = false; }
  };
}

/* ---------- Ajuste de existencia (conteo físico) ---------- */
function modalAjuste(id) {
  const p = Estado.productos.find(x => x.id === id);
  abrirModal(`
    <div class="modal-cab"><h3>Ajustar existencia</h3><button class="btn-icono" data-cerrar>✕</button></div>
    <p class="sub" style="margin-bottom:14px"><span class="codigo">${esc(p.codigo)}</span> <b>${esc(p.nombre)}</b> · Existencia actual: <b>${fmtCant(p.stock, p.unidad)}</b></p>
    <form id="form-ajuste">
      <label>Existencia real contada ${p.unidad === "kg" ? "(kg)" : "(unidades)"}<input type="number" id="aj-nuevo" step="${p.unidad === "kg" ? "0.001" : "1"}" min="0" required value="${p.stock}"></label>
      <label>Motivo
        <select id="aj-motivo"><option>Conteo físico</option><option>Corrección de error</option><option>Otro</option></select>
      </label>
      <label>Nota (opcional)<input id="aj-nota" placeholder="Detalle del ajuste"></label>
      <p class="nota">Para lo que se toma para la casa o se daña, usa el módulo <b>Autoconsumo y Mermas</b> (próxima entrega), así se descuenta en la utilidad.</p>
      <div class="acciones modal-pie"><span style="flex:1"></span>
        <button type="button" class="btn btn-fantasma" data-cerrar>Cancelar</button>
        <button class="btn btn-primario">Guardar ajuste</button>
      </div>
    </form>`, 460);
  $("#form-ajuste").onsubmit = async e => {
    e.preventDefault();
    const nuevo = Number($("#aj-nuevo").value);
    if (nuevo === Number(p.stock)) return cerrarModal();
    const motivo = $("#aj-motivo").value + ($("#aj-nota").value.trim() ? ": " + $("#aj-nota").value.trim() : "");
    try { await Store.ajustarStock(id, nuevo, motivo, Estado.usuario.nombre); toast("Existencia ajustada ✔"); cerrarModal(); }
    catch (err) { toast(traducirError(err), true); }
  };
}

/* ---------- Historial de movimientos (kárdex) ---------- */
async function modalMovimientos(id) {
  const p = Estado.productos.find(x => x.id === id);
  abrirModal(`<div class="modal-cab"><h3>Movimientos</h3><button class="btn-icono" data-cerrar>✕</button></div><div class="spinner" style="margin:20px auto"></div>`);
  const movs = await Store.movimientos(id).catch(() => []);
  const tipos = { inicial: "Inicial", ajuste: "Ajuste", venta: "Venta", compra: "Compra", autoconsumo: "Autoconsumo", merma: "Merma" };
  $("#modal-caja").innerHTML = `
    <div class="modal-cab"><h3>Movimientos</h3><button class="btn-icono" data-cerrar>✕</button></div>
    <p class="sub" style="margin-bottom:12px"><span class="codigo">${esc(p.codigo)}</span> <b>${esc(p.nombre)}</b> · Actual: <b>${fmtCant(p.stock, p.unidad)}</b></p>
    <div class="tabla-wrap"><table>
      <thead><tr><th>Fecha</th><th>Tipo</th><th class="num">Cantidad</th><th class="num">Queda</th><th>Detalle</th></tr></thead>
      <tbody>${movs.length ? movs.map(m => `<tr>
        <td>${new Date(m._t).toLocaleString("es-VE", { dateStyle: "short", timeStyle: "short" })}</td>
        <td>${tipos[m.tipo] || m.tipo}</td>
        <td class="num ${m.cantidad < 0 ? "neg" : "pos"}">${m.cantidad > 0 ? "+" : ""}${fmtCant(m.cantidad, p.unidad)}</td>
        <td class="num">${fmtCant(m.despues, p.unidad)}</td>
        <td><small>${esc(m.motivo || "")}<br>${esc(m.usuario || "")}</small></td>
      </tr>`).join("") : `<tr><td colspan="5" class="vacio">Sin movimientos registrados.</td></tr>`}</tbody>
    </table></div>`;
  $$("[data-cerrar]", $("#modal")).forEach(b => b.onclick = cerrarModal);
}

/* ---------- Lista de Precios (solo dueño) ---------- */
const filtrosPre = { texto: "", cat: "", negativos: false };

function vistaPrecios() {
  $("#vista").innerHTML = `
    <div class="cabecera-precios" id="pre-cab"></div>
    <div class="barra-herr">
      <input id="pre-buscar" class="buscador" placeholder="🔍 Código o nombre" autocomplete="off" value="${esc(filtrosPre.texto)}">
      <select id="pre-cat"><option value="">Todas las categorías</option>${categorias().map(c => `<option ${c === filtrosPre.cat ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
      <label class="check"><input type="checkbox" id="pre-neg" ${filtrosPre.negativos ? "checked" : ""}> Solo en pérdida</label>
      <button class="btn btn-primario" id="pre-nuevo">+ Nuevo producto</button>
    </div>
    <div class="tarjeta sin-pad">
      <div class="tabla-wrap"><table class="tabla-precios">
        <thead><tr>
          <th>Código</th><th>Producto</th><th class="num">Costo $<br><small>con IVA</small></th><th class="num">Costo Bs<br><small>tasa de hoy</small></th>
          <th class="num">Precio venta Bs</th><th class="num">Ref. $</th><th class="num">% Ganancia</th>
        </tr></thead>
        <tbody id="pre-body"></tbody>
      </table></div>
    </div>
    <p class="nota">Escribe el <b>precio de venta</b> o el <b>% de ganancia</b> y pulsa Enter: se guarda al instante y es el precio que verá el punto de venta. Las filas en <span class="neg"><b>rojo</b></span> venden por debajo del costo con la tasa de hoy.</p>`;

  const pintar = () => {
    // No repintar mientras se está escribiendo en la tabla (para no perder lo que se escribe)
    if ($("#pre-body")?.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;
    const t = Estado.tasa, vieja = !t || t.fecha !== hoyISO();
    const todos = filtrarProductos();
    const enPerdida = todos.filter(p => (margen(p) ?? 0) < 0).length;
    const bajos = todos.filter(p => { const m = margen(p); return m != null && m >= 0 && m < 10; }).length;
    $("#pre-cab").innerHTML = `
      <div class="tasa-grande ${vieja ? "vieja" : ""}">
        <small>Tasa BCV ${t ? (vieja ? "del " + fechaCorta(t.fecha) + " ⚠ no es de hoy" : "de hoy · " + fechaCorta(t.fecha)) : "sin registrar"}</small>
        <strong>${t ? "Bs " + Number(t.valor).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : "—"}</strong>
        <button class="btn btn-sm btn-secundario" data-vista="config">Actualizar tasa</button>
      </div>
      <div class="tarjeta kpi cielo"><small>Productos</small><strong>${todos.length}</strong><span>IVA ${pctIva()}% en los que gravan</span></div>
      <div class="tarjeta kpi ${enPerdida ? "rosa" : "verde"}"><small>En pérdida</small><strong>${enPerdida}</strong><span>${enPerdida ? "ajustar precio" : "todo en orden"}</span></div>
      <div class="tarjeta kpi amarillo"><small>Ganancia menor a 10%</small><strong>${bajos}</strong><span>margen ajustado</span></div>`;
    $$("#pre-cab [data-vista]").forEach(b => b.onclick = () => irA(b.dataset.vista));

    const lista = filtrarProductos(filtrosPre).filter(p => !filtrosPre.negativos || (margen(p) ?? 0) < 0);
    $("#pre-body").innerHTML = lista.length ? lista.map(p => filaPrecio(p)).join("")
      : `<tr><td colspan="7" class="vacio">${Estado.productos.length ? "Sin resultados." : "Aún no hay productos. Pulsa <b>+ Nuevo producto</b>."}</td></tr>`;
    conectarFilasPrecio();
  };
  Estado.repintar = pintar;
  pintar();

  $("#pre-buscar").oninput = e => { filtrosPre.texto = e.target.value; pintar(); };
  $("#pre-cat").onchange = e => { filtrosPre.cat = e.target.value; pintar(); };
  $("#pre-neg").onchange = e => { filtrosPre.negativos = e.target.checked; pintar(); };
  $("#pre-nuevo").onclick = () => modalProducto();
}

function filaPrecio(p) {
  const m = margen(p), cB = costoBs(p);
  const cls = m == null ? "" : m < 0 ? "fila-neg" : m < 10 ? "fila-ajustada" : "";
  return `<tr class="${cls}" data-id="${p.id}">
    <td><span class="codigo">${esc(p.codigo)}</span></td>
    <td><a href="#" class="nombre-link" data-editar="${p.id}">${esc(p.nombre)}</a><br><small class="sub">${p.unidad === "kg" ? "por kg" : "por unidad"} · ${p.iva ? `<span class="tag-iva">IVA ${pctIva()}%</span>` : "Exento"}</small></td>
    <td class="num">${fmtUsd(costoUsdReal(p))}${p.iva ? `<br><small class="sub">${fmtUsd(p.costoUsd)} + IVA</small>` : ""}</td>
    <td class="num">${cB == null ? "—" : fmtBs(cB)}</td>
    <td class="num"><input type="number" class="in-precio" step="0.01" min="0" value="${Number(p.precioBs || 0).toFixed(2)}"></td>
    <td class="num ref">${tasaHoy() ? fmtUsd(p.precioBs / tasaHoy()) : "—"}</td>
    <td class="num"><input type="number" class="in-margen" step="0.1" value="${m == null ? "" : m.toFixed(1)}" ${m == null ? "disabled placeholder='—'" : ""}></td>
  </tr>`;
}

function conectarFilasPrecio() {
  $$("#pre-body [data-editar]").forEach(a => a.onclick = e => { e.preventDefault(); modalProducto(a.dataset.editar); });
  $$("#pre-body tr[data-id]").forEach(tr => {
    const p = () => Estado.productos.find(x => x.id === tr.dataset.id);
    const inP = $(".in-precio", tr), inM = $(".in-margen", tr);

    // Vista previa mientras se escribe (sin guardar)
    const previa = precio => {
      const tmp = { ...p(), precioBs: precio }, m = margen(tmp);
      tr.className = m == null ? "" : m < 0 ? "fila-neg" : m < 10 ? "fila-ajustada" : "";
      $(".ref", tr).textContent = tasaHoy() ? fmtUsd(precio / tasaHoy()) : "—";
      return m;
    };
    inP.oninput = () => { const m = previa(Number(inP.value || 0)); if (m != null) inM.value = m.toFixed(1); };
    inM.oninput = () => {
      const pct = parseFloat(inM.value);
      if (isNaN(pct)) return;
      const precio = precioDesdeMargen(p(), pct);
      inP.value = precio.toFixed(2); previa(precio);
    };

    const guardar = async () => {
      const nuevo = red2(inP.value || 0);
      if (nuevo === red2(p().precioBs || 0)) return;
      if (nuevo <= 0 && !confirm("¿Dejar este producto con precio 0?")) { inP.value = Number(p().precioBs).toFixed(2); return; }
      try { await Store.actualizarProducto(p().id, { precioBs: nuevo }); toast(`${p().codigo} · nuevo precio ${fmtBs(nuevo)} ✔`); }
      catch (e) { toast(traducirError(e), true); }
    };
    [inP, inM].forEach(inp => {
      inp.onchange = guardar;
      inp.onkeydown = e => {
        if (e.key !== "Enter") return;
        e.preventDefault(); inp.blur();
        // Pasa al precio de la fila siguiente para editar en serie
        const sig = tr.nextElementSibling && $(inp.classList.contains("in-precio") ? ".in-precio" : ".in-margen", tr.nextElementSibling);
        if (sig) { sig.focus(); sig.select(); }
      };
      inp.onfocus = () => inp.select();
      inp.onblur = () => setTimeout(() => { if (!$("#pre-body")?.contains(document.activeElement)) Estado.repintar && Estado.repintar(); }, 150);
    });
  });
}

/* =========================================================
   PUNTO DE VENTA
   Flujo: código (o 3*código) + Enter → la línea se agrega (si ya está, se suma)
          F10 → panel de cobro → 01..05 + monto → 99 para guardar
   ========================================================= */
const TIPOS_PAGO = {
  "01": { nombre: "DÉBITO",        moneda: "Bs", ref: false },
  "02": { nombre: "EFECTIVO",      moneda: "Bs", ref: false },
  "03": { nombre: "DIVISAS",       moneda: "$",  ref: false },
  "04": { nombre: "PAGO MÓVIL",    moneda: "Bs", ref: false },  // ref: true para pedir referencia (cuando se use)
  "05": { nombre: "TRANSFERENCIA", moneda: "Bs", ref: false }
};
const POS = { teclas: [], tScan: null, carrito: [], pagos: [], sug: [], selSug: 0, pesoDe: null, paso: "opcion", tipoSel: null, montoSel: 0, ultima: null, guardando: false };
const CARRO_KEY = "abastoGFL_carrito";
const guardarCarro = () => { try { localStorage.setItem(CARRO_KEY, JSON.stringify(POS.carrito)); } catch {} };
const ESPERA_KEY = "abastoGFL_espera";
const leerEspera = () => { try { return JSON.parse(localStorage.getItem(ESPERA_KEY)) || []; } catch { return []; } };
const guardarEspera = l => { try { localStorage.setItem(ESPERA_KEY, JSON.stringify(l)); } catch {} };
const cargarCarro = () => { try { POS.carrito = JSON.parse(localStorage.getItem(CARRO_KEY)) || []; } catch { POS.carrito = []; } };
const totalCarroBs = () => red2(POS.carrito.reduce((a, l) => a + red2(l.cantidad * l.precioBs), 0));
const pagadoBs = () => red2(POS.pagos.reduce((a, p) => a + p.montoBs, 0));
const tolerancia = () => Math.max(0.05, tasaHoy() * 0.005); // medio centavo de dólar por redondeos
const productoActivo = cod => Estado.productos.find(p => p.activo !== false && normal(p.codigo) === normal(cod));

/* ---------- Sonidos (sin archivos) ---------- */
let audioCtx;
function sonar(tipo) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const notas = tipo === "error" ? [[260, 0, .2], [190, .24, .35]] : tipo === "ok" ? [[784, 0, .12], [1175, .13, .22]] : [[1200, 0, .05]];
    notas.forEach(([f, ini, dur]) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain(), t0 = audioCtx.currentTime + ini;
      o.type = tipo === "error" ? "square" : "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(tipo === "error" ? .12 : .18, t0);
      g.gain.exponentialRampToValueAtTime(.001, t0 + dur);
      o.connect(g); g.connect(audioCtx.destination); o.start(t0); o.stop(t0 + dur + .02);
    });
  } catch {}
}
function flash(tipo, html) {
  const f = $("#pos-flash"); if (!f) return;
  f.innerHTML = `<div>${html}</div>`;
  f.className = "pos-flash ver " + tipo;
  clearTimeout(flash._t);
  flash._t = setTimeout(() => (f.className = "pos-flash"), tipo === "ok" ? 1400 : 2200);
}

/* ---------- Vista ---------- */
function vistaVender() {
  cargarCarro();
  const t = Estado.tasa;
  $("#vista").innerHTML = `
  <div class="pos">
    <div class="pos-izq">
      <div class="pos-entrada">
        <div class="pos-campo">
          <label for="pos-codigo">Código del producto</label>
          <input id="pos-codigo" autocomplete="off" placeholder="Escanee o escriba el código y Enter · 3*001 = 3 unidades">
          <div id="pos-sug" class="pos-sug oculto"></div>
        </div>
        <div class="pos-campo pos-peso oculto" id="pos-peso-box">
          <label for="pos-peso" id="pos-peso-lbl">Peso (kg)</label>
          <input id="pos-peso" type="number" step="0.001" min="0" inputmode="decimal" placeholder="0,000">
        </div>
      </div>
      <div class="tarjeta sin-pad pos-lineas">
        <table class="tabla-pos">
          <thead><tr><th>#</th><th>Código</th><th>Producto</th><th class="num">Cant. / Kg</th><th class="num">Precio unit. Bs</th><th class="num">Subtotal Bs</th><th></th></tr></thead>
          <tbody id="pos-body"></tbody>
        </table>
      </div>
    </div>

    <aside class="pos-der">
      <div class="pos-total">
        <small>TOTAL A COBRAR</small>
        <strong id="pos-total-bs">Bs 0,00</strong>
        <span id="pos-total-usd"></span>
        <em id="pos-items">0 productos</em>
      </div>
      <button class="btn btn-primario btn-bloque btn-cobrar" id="pos-cobrar">💳 Cobrar <kbd>F10</kbd></button>
      <div class="pos-espera-btns">
        <button class="btn btn-secundario" id="pos-poner-espera">⏳ Poner en espera <kbd>F4</kbd></button>
        <button class="btn btn-secundario" id="pos-ver-espera">🕒 Ventas en espera <kbd>F6</kbd> <span class="contador" id="pos-n-espera">0</span></button>
      </div>
      <button class="btn btn-fantasma btn-bloque" id="pos-anular">Anular venta <kbd>F8</kbd></button>
      ${!t ? `<p class="pos-aviso">⚠ No hay tasa BCV registrada: no se podrá cobrar en divisas.</p>`
           : t.fecha !== hoyISO() ? `<p class="pos-aviso">⚠ La tasa BCV es del ${fechaCorta(t.fecha)}. Pide al dueño actualizarla.</p>` : ""}
      <div class="pos-ayuda">
        <b>Atajos</b>
        <div><kbd>Enter</kbd> agregar producto</div>
        <div>Lector: agrega solo, sin Enter</div>
        <div><kbd>3*001</kbd> 3 unidades del 001</div>
        <div><kbd>F4</kbd> en espera · <kbd>F6</kbd> ver espera</div>
        <div><kbd>F10</kbd> cobrar · <kbd>99</kbd> guardar</div>
        <div><kbd>Esc</kbd> regresar / cerrar cobro</div>
      </div>
      <div class="pos-ultima" id="pos-ultima"></div>
    </aside>
  </div>

  <div id="pos-pago" class="pos-pago oculto">
    <div class="pp-caja" id="pp-caja">
      <div class="pp-cab"><h3>Seleccione el tipo de pago</h3><button class="btn-icono" id="pp-cerrar" title="Esc">✕</button></div>
      <div class="pp-grid">
        <div class="pp-opciones">
          ${Object.entries(TIPOS_PAGO).map(([c, tp]) => `<button class="pp-op" data-op="${c}"><b>${c}</b><span>${tp.nombre}</span><small>${tp.moneda}</small></button>`).join("")}
        </div>
        <div class="pp-centro">
          <label for="pp-input" id="pp-lbl">Escriba el código del tipo de pago</label>
          <input id="pp-input" autocomplete="off" inputmode="decimal">
          <p class="pp-hint" id="pp-hint"></p>
          <ul id="pp-lista" class="pp-lista"></ul>
        </div>
        <div class="pp-resumen">
          <div><small>Total</small><b id="pp-total"></b><span id="pp-total-usd"></span></div>
          <div><small>Pagado</small><b id="pp-pagado"></b></div>
          <div id="pp-dif-box"><small id="pp-dif-lbl">Falta</small><b id="pp-dif"></b><span id="pp-dif-usd"></span></div>
          <button class="btn btn-primario btn-bloque" id="pp-guardar">Guardar venta <kbd>99</kbd></button>
        </div>
      </div>
      <div id="pp-alerta" class="pp-alerta oculto"></div>
    </div>
  </div>
  <div id="pos-flash" class="pos-flash"></div>`;

  Estado.repintar = actualizarTotales; // no repinta el cobro para no borrar lo que escribe el cajero
  pintarLineas();
  pintarUltima();
  pintarContadorEspera();
  conectarPOS();
  $("#pos-codigo").focus();
}

function pintarLineas(resaltar = null) {
  const body = $("#pos-body"); if (!body) return;
  body.innerHTML = POS.carrito.length ? POS.carrito.map((l, i) => `
    <tr data-i="${i}" class="${l.productoId === resaltar ? "resalta" : ""}">
      <td class="sub">${i + 1}</td>
      <td><span class="codigo">${esc(l.codigo)}</span></td>
      <td><b>${esc(l.nombre)}</b></td>
      <td class="num"><input type="number" class="in-cant" min="0" step="${l.unidad === "kg" ? "0.001" : "1"}" value="${l.unidad === "kg" ? l.cantidad.toFixed(3) : l.cantidad}"><small class="sub"> ${l.unidad}</small></td>
      <td class="num">${fmtBs(l.precioBs)}</td>
      <td class="num"><b>${fmtBs(l.cantidad * l.precioBs)}</b></td>
      <td><button class="btn-quitar" data-quitar="${i}" title="Quitar">✕</button></td>
    </tr>`).join("")
    : `<tr><td colspan="7" class="vacio pos-vacio">🛒<br>Escanee o escriba el código del primer producto</td></tr>`;

  $$(".in-cant", body).forEach(inp => {
    inp.onchange = () => {
      const l = POS.carrito[inp.closest("tr").dataset.i];
      const n = Number(inp.value);
      if (!(n > 0)) { POS.carrito.splice(inp.closest("tr").dataset.i, 1); }
      else l.cantidad = l.unidad === "kg" ? +n.toFixed(3) : Math.round(n);
      guardarCarro(); pintarLineas();
    };
    inp.onkeydown = e => { if (e.key === "Enter") { inp.blur(); $("#pos-codigo").focus(); } };
  });
  $$("[data-quitar]", body).forEach(b => b.onclick = () => {
    POS.carrito.splice(b.dataset.quitar, 1); guardarCarro(); pintarLineas(); $("#pos-codigo").focus();
  });
  const fila = $("tr.resalta", body);
  if (fila) fila.scrollIntoView({ block: "nearest" });
  actualizarTotales();
}

function actualizarTotales() {
  if (!$("#pos-total-bs")) return;
  const tot = totalCarroBs();
  $("#pos-total-bs").textContent = fmtBs(tot);
  $("#pos-total-usd").textContent = tasaHoy() ? fmtUsd(tot / tasaHoy()) + " ref." : "";
  const n = POS.carrito.length;
  $("#pos-items").textContent = n + (n === 1 ? " producto" : " productos");
}

function pintarUltima() {
  const u = POS.ultima, box = $("#pos-ultima"); if (!box) return;
  box.innerHTML = u ? `<small>Última venta</small><b>#${numVenta(u.numero)}</b> · ${fmtBs(u.totalBs)}<br><small>${u.hora} · ${u.pagos}</small>` : "";
}

/* ---------- Agregar productos ---------- */
function agregarAlCarro(p, cantidad) {
  if (!(cantidad > 0)) return;
  const i = POS.carrito.findIndex(x => x.productoId === p.id);
  if (i >= 0) {
    // Ya estaba: se suma la cantidad y la línea baja al final (donde se agregan los nuevos)
    const [l] = POS.carrito.splice(i, 1);
    l.cantidad = +(l.cantidad + cantidad).toFixed(3);
    POS.carrito.push(l);
  } else POS.carrito.push({ productoId: p.id, codigo: p.codigo, nombre: p.nombre, unidad: p.unidad,
                            cantidad: +cantidad.toFixed(3), precioBs: Number(p.precioBs || 0) });
  guardarCarro();
  sonar("beep");
  pintarLineas(p.id);
  if (!(p.precioBs > 0)) toast(`⚠ ${p.nombre} no tiene precio de venta`, true);
}

function pedirPeso(p, cant = null) {
  POS.pesoDe = p;
  $("#pos-peso-box").classList.remove("oculto");
  $("#pos-peso-lbl").innerHTML = `Peso en kg · <b>${esc(p.nombre)}</b> · ${fmtBs(p.precioBs)}/kg`;
  const inp = $("#pos-peso");
  inp.value = cant ?? "";
  inp.focus(); inp.select();
}
function cerrarPeso() {
  POS.pesoDe = null;
  $("#pos-peso-box").classList.add("oculto");
  $("#pos-codigo").value = "";
  $("#pos-codigo").focus();
}

function mostrarSugerencias(txt) {
  const box = $("#pos-sug");
  const t = normal(txt);
  POS.sug = t.length >= 2 && !productoActivo(txt)
    ? Estado.productos.filter(p => p.activo !== false && (normal(p.nombre).includes(t) || normal(p.codigo).startsWith(t))).sort(ordenarCodigo).slice(0, 8)
    : [];
  POS.selSug = 0;
  box.classList.toggle("oculto", !POS.sug.length);
  box.innerHTML = POS.sug.map((p, i) => `<div class="sug ${i === 0 ? "sel" : ""}" data-s="${i}"><span class="codigo">${esc(p.codigo)}</span> ${esc(p.nombre)} <b>${fmtBs(p.precioBs)}${p.unidad === "kg" ? "/kg" : ""}</b></div>`).join("");
  $$("[data-s]", box).forEach(d => d.onmousedown = e => { e.preventDefault(); POS.selSug = +d.dataset.s; procesarCodigo(); });
}

function procesarCodigo() {
  const inp = $("#pos-codigo");
  const txt = inp.value.trim();
  if (!txt) return;
  let cant = null, cod = txt;
  const m = txt.match(/^(\d+(?:[.,]\d+)?)\s*\*\s*(.+)$/);   // 3*001  ó  0,750*001
  if (m) { cant = parseFloat(m[1].replace(",", ".")); cod = m[2].trim(); }

  POS.teclas = [];
  let p = productoActivo(cod);
  if (!p && POS.sug.length) p = POS.sug[POS.selSug];
  $("#pos-sug").classList.add("oculto"); POS.sug = [];
  if (!p) { sonar("error"); toast(`El código "${cod}" no existe`, true); inp.select(); return; }

  if (p.unidad === "kg" && cant == null) { pedirPeso(p); return; }
  agregarAlCarro(p, cant ?? 1);
  inp.value = "";
}

/* ---------- Cobro ---------- */
function abrirCobro() {
  if (!POS.carrito.length) { sonar("error"); toast("No hay productos en la venta", true); return; }
  if (POS.pesoDe) cerrarPeso();
  POS.pagos = []; POS.paso = "opcion"; POS.tipoSel = null;
  $("#pos-pago").classList.remove("oculto");
  $("#pp-alerta").classList.add("oculto");
  pintarPago();
}
function cerrarCobro() {
  $("#pos-pago").classList.add("oculto");
  POS.pagos = []; POS.paso = "opcion";
  $("#pos-codigo").focus();
}

function pintarPago() {
  const tot = totalCarroBs(), pag = pagadoBs(), dif = red2(tot - pag);
  $("#pp-total").textContent = fmtBs(tot);
  $("#pp-total-usd").textContent = tasaHoy() ? fmtUsd(tot / tasaHoy()) : "";
  $("#pp-pagado").textContent = fmtBs(pag);
  const cuadra = Math.abs(dif) <= tolerancia();
  $("#pp-dif-lbl").textContent = cuadra ? "Cuadra" : dif > 0 ? "Falta" : "Sobra";
  $("#pp-dif").textContent = cuadra ? "✔" : fmtBs(Math.abs(dif));
  $("#pp-dif-usd").textContent = !cuadra && tasaHoy() ? fmtUsd(Math.abs(dif) / tasaHoy()) : "";
  $("#pp-dif-box").className = cuadra ? "ok" : "mal";

  $("#pp-lista").innerHTML = POS.pagos.map((p, i) => `
    <li><span><b>${p.codigo}</b> ${p.tipo}${p.ref ? ` <small>Ref. ${esc(p.ref)}</small>` : ""}</span>
      <span>${p.moneda === "$" ? fmtUsd(p.monto) + ` <small>(${fmtBs(p.montoBs)})</small>` : fmtBs(p.montoBs)}
      <button class="btn-quitar" data-qp="${i}">✕</button></span></li>`).join("");
  $$("[data-qp]").forEach(b => b.onclick = () => { POS.pagos.splice(b.dataset.qp, 1); POS.paso = "opcion"; pintarPago(); });

  $$(".pp-op").forEach(b => b.classList.toggle("activo", b.dataset.op === POS.tipoSel && POS.paso !== "opcion"));
  const inp = $("#pp-input"), tp = TIPOS_PAGO[POS.tipoSel];
  if (POS.paso === "opcion") {
    $("#pp-lbl").textContent = "Escriba el código del tipo de pago";
    $("#pp-hint").innerHTML = POS.pagos.length ? "Otro tipo de pago (pago mixto) o escriba <b>99</b> para guardar" : "01 al 05 y Enter";
    inp.value = ""; inp.placeholder = "01 - 05";
  } else if (POS.paso === "monto") {
    const faltaBs = Math.max(0, dif);
    $("#pp-lbl").innerHTML = `Monto en <b>${tp.moneda === "$" ? "dólares" : "bolívares"}</b> · ${POS.tipoSel} ${tp.nombre}`;
    $("#pp-hint").innerHTML = "Enter para aceptar · Esc para regresar";
    inp.value = tp.moneda === "$" ? (faltaBs / tasaHoy()).toFixed(2) : faltaBs.toFixed(2);
    inp.placeholder = "0.00";
  } else if (POS.paso === "ref") {
    $("#pp-lbl").innerHTML = `Referencia · ${POS.tipoSel} ${tp.nombre}`;
    $("#pp-hint").innerHTML = "Últimos dígitos de la referencia (opcional) y Enter";
    inp.value = ""; inp.placeholder = "Ej: 004512";
  }
  inp.focus(); inp.select();
}

function elegirTipo(c) {
  if (!TIPOS_PAGO[c]) { alertaPago("Ese tipo de pago no existe. Use 01, 02, 03, 04 o 05."); return; }
  if (TIPOS_PAGO[c].moneda === "$" && !tasaHoy()) { alertaPago("No hay tasa BCV registrada: no se puede cobrar en divisas."); return; }
  if (pagadoBs() >= totalCarroBs() - tolerancia()) { alertaPago("El total ya está cubierto. Escriba 99 para guardar o quite un pago."); return; }
  $("#pp-alerta").classList.add("oculto");
  POS.tipoSel = c; POS.paso = "monto";
  pintarPago();
}

function entradaPago(valor) {
  valor = valor.trim();
  if (POS.paso === "opcion") {
    if (valor === "99") return finalizarVenta();
    return elegirTipo(valor.padStart(2, "0"));
  }
  if (POS.paso === "monto") {
    const n = parseFloat(valor.replace(",", "."));
    if (!(n > 0)) return alertaPago("Escriba un monto válido.");
    POS.montoSel = n;
    if (TIPOS_PAGO[POS.tipoSel].ref) { POS.paso = "ref"; return pintarPago(); }
    return agregarPago("");
  }
  if (POS.paso === "ref") return agregarPago(valor);
}

function agregarPago(ref) {
  const tp = TIPOS_PAGO[POS.tipoSel], n = POS.montoSel;
  const montoBs = tp.moneda === "$" ? red2(n * tasaHoy()) : red2(n);
  POS.pagos.push({
    codigo: POS.tipoSel, tipo: tp.nombre, moneda: tp.moneda, monto: red2(n), montoBs,
    montoUsd: tasaHoy() ? red2(montoBs / tasaHoy()) : null, ref: ref || ""
  });
  POS.paso = "opcion"; POS.tipoSel = null;
  sonar("beep");
  pintarPago();
}

function alertaPago(msg) {
  sonar("error");
  const a = $("#pp-alerta");
  a.innerHTML = msg;
  a.classList.remove("oculto");
  const caja = $("#pp-caja");
  caja.classList.remove("sacude"); void caja.offsetWidth; caja.classList.add("sacude");
  $("#pp-input").select();
}

async function finalizarVenta() {
  if (POS.guardando) return;
  const tot = totalCarroBs(), pag = pagadoBs(), dif = red2(pag - tot);
  if (!POS.pagos.length) return alertaPago("⚠ Seleccione el tipo de pago antes de guardar.");
  if (Math.abs(dif) > tolerancia()) {
    const usd = tasaHoy() ? ` (${fmtUsd(Math.abs(dif) / tasaHoy())})` : "";
    return alertaPago(`⚠ EL COBRO NO CUADRA CON EL TOTAL<br>${dif < 0 ? "FALTAN" : "SOBRAN"} <b>${fmtBs(Math.abs(dif))}</b>${usd}`);
  }

  const tasa = tasaHoy() || null;
  const items = POS.carrito.map(l => {
    const p = Estado.productos.find(x => x.id === l.productoId) || {};
    const cU = costoUsdReal(p);
    return {
      productoId: l.productoId, codigo: l.codigo, nombre: l.nombre, unidad: l.unidad,
      cantidad: l.cantidad, precioBs: l.precioBs, subtotalBs: red2(l.cantidad * l.precioBs),
      costoUsd: +cU.toFixed(4), costoBs: tasa ? red2(cU * tasa) : 0
    };
  });
  const costoTotal = red2(items.reduce((a, i) => a + i.costoBs * i.cantidad, 0));
  const venta = {
    dia: hoyISO(), cajeroUid: Estado.usuario.uid, cajero: Estado.usuario.nombre, tasa,
    items, totalBs: tot, totalUsd: tasa ? red2(tot / tasa) : null,
    costoBs: costoTotal, utilidadBs: red2(tot - costoTotal),
    pagos: POS.pagos, anulada: false
  };

  POS.guardando = true;
  $("#pp-guardar").disabled = true;
  try {
    const numero = await Store.registrarVenta(venta);
    POS.ultima = { numero, totalBs: tot, hora: new Date().toLocaleTimeString("es-VE", { hour: "2-digit", minute: "2-digit" }),
                   pagos: POS.pagos.map(p => p.tipo).join(" + ") };
    POS.carrito = []; guardarCarro();
    cerrarCobro();
    pintarLineas(); pintarUltima();
    sonar("ok");
    flash("ok", `✔ Venta #${numVenta(numero)} guardada<br><small>${fmtBs(tot)}</small>`);
  } catch (e) {
    alertaPago("No se pudo guardar la venta: " + traducirError(e) + "<br><small>Revise la conexión a internet e intente de nuevo con 99.</small>");
  } finally {
    POS.guardando = false;
    if ($("#pp-guardar")) $("#pp-guardar").disabled = false;
  }
}

function anularVentaActual() {
  if (!POS.carrito.length) return;
  if (!confirm("¿Anular la venta en curso? Se borrarán todos los productos de la pantalla.")) return;
  POS.carrito = []; guardarCarro(); cerrarCobro(); pintarLineas();
}


/* ---------- Ventas en espera ----------
   Se guardan en este equipo (caja). Sirven cuando el cliente va a buscar
   otro medio de pago: la venta queda guardada y luego se vuelve a cargar. */
function pintarContadorEspera() {
  const n = leerEspera().length, c = $("#pos-n-espera");
  if (!c) return;
  c.textContent = n;
  c.classList.toggle("hay", n > 0);
}

function ponerEnEspera() {
  if (!POS.carrito.length) { sonar("error"); toast("No hay productos para poner en espera", true); return; }
  if (POS.pesoDe) cerrarPeso();
  const sugerido = "Cliente " + (leerEspera().length + 1);
  abrirModal(`
    <div class="modal-cab"><h3>⏳ ¿Desea colocar la venta en espera?</h3><button class="btn-icono" data-cerrar>✕</button></div>
    <form id="form-espera">
      <p class="sub" style="margin-bottom:12px">${POS.carrito.length} producto(s) · <b>${fmtBs(totalCarroBs())}</b>${tasaHoy() ? " · " + fmtUsd(totalCarroBs() / tasaHoy()) : ""}</p>
      <label>Nombre o referencia del cliente<input id="esp-nombre" value="${sugerido}" maxlength="40"></label>
      <div class="acciones modal-pie"><span style="flex:1"></span>
        <button type="button" class="btn btn-fantasma" data-cerrar>No</button>
        <button class="btn btn-primario">Sí, poner en espera</button>
      </div>
    </form>`, 440);
  $("#esp-nombre").select();
  $("#form-espera").onsubmit = e => {
    e.preventDefault();
    const lista = leerEspera();
    lista.push({
      id: "e" + Date.now(), nombre: $("#esp-nombre").value.trim() || sugerido,
      hora: new Date().toLocaleTimeString("es-VE", { hour: "2-digit", minute: "2-digit" }),
      cajero: Estado.usuario.nombre, items: POS.carrito, totalBs: totalCarroBs()
    });
    guardarEspera(lista);
    POS.carrito = []; guardarCarro();
    cerrarModal(); cerrarCobro(); pintarLineas(); pintarContadorEspera();
    sonar("beep");
    toast("Venta puesta en espera ⏳");
  };
}

function verEspera() {
  const lista = leerEspera();
  abrirModal(`
    <div class="modal-cab"><h3>🕒 Ventas en espera</h3><button class="btn-icono" data-cerrar>✕</button></div>
    ${lista.length ? `<ul class="lista-espera">${lista.map(v => `
      <li>
        <div><b>${esc(v.nombre)}</b><br><small class="sub">${v.hora} · ${v.items.length} producto(s) · ${esc(v.cajero || "")}</small></div>
        <strong>${fmtBs(v.totalBs)}</strong>
        <button class="btn btn-primario btn-sm" data-cargar="${v.id}">Cargar</button>
        <button class="btn-quitar" data-borrar="${v.id}" title="Eliminar">✕</button>
      </li>`).join("")}</ul>`
    : `<p class="vacio">No hay ventas en espera.</p>`}`, 560);

  $$("[data-cargar]").forEach(b => b.onclick = () => cargarEspera(b.dataset.cargar));
  $$("[data-borrar]").forEach(b => b.onclick = () => {
    if (!confirm("¿Eliminar esta venta en espera? Se perderán sus productos.")) return;
    guardarEspera(leerEspera().filter(v => v.id !== b.dataset.borrar));
    pintarContadorEspera(); verEspera();
  });
  $("[data-cargar]")?.focus();
}

function cargarEspera(id) {
  let lista = leerEspera();
  const v = lista.find(x => x.id === id);
  if (!v) return;
  lista = lista.filter(x => x.id !== id);
  // Si había otra venta en pantalla, se intercambia: la actual pasa a espera
  if (POS.carrito.length) {
    if (!confirm("Hay una venta en pantalla. ¿Ponerla en espera y cargar la de " + v.nombre + "?")) return;
    lista.push({ id: "e" + Date.now(), nombre: "Cliente " + (lista.length + 1),
      hora: new Date().toLocaleTimeString("es-VE", { hour: "2-digit", minute: "2-digit" }),
      cajero: Estado.usuario.nombre, items: POS.carrito, totalBs: totalCarroBs() });
  }
  guardarEspera(lista);
  POS.carrito = v.items; guardarCarro();
  cerrarModal(); pintarLineas(); pintarContadorEspera();
  sonar("beep");
  toast(`Venta de ${v.nombre} cargada · ${fmtBs(totalCarroBs())}`);
}

/* ---------- Teclado y eventos ---------- */
function conectarPOS() {
  const cod = $("#pos-codigo");
  cod.oninput = () => {
    clearTimeout(POS.tScan);
    const t = POS.teclas, txt = cod.value.trim();
    // El lector "teclea" todo el código en milisegundos; una persona no.
    const esLector = t.length >= 4 && (t[t.length - 1] - t[0]) / (t.length - 1) < 35;
    if (esLector) {
      $("#pos-sug").classList.add("oculto");
      POS.tScan = setTimeout(() => { if (productoActivo(cod.value.trim())) procesarCodigo(); }, 90);
    } else mostrarSugerencias(txt);
  };
  cod.onkeydown = e => {
    if (e.key.length === 1) { if (!cod.value || cod.selectionStart === 0 && cod.selectionEnd === cod.value.length) POS.teclas = []; POS.teclas.push(performance.now()); }
    if (e.key === "Enter") { e.preventDefault(); clearTimeout(POS.tScan); procesarCodigo(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!POS.sug.length) return;
      e.preventDefault();
      POS.selSug = (POS.selSug + (e.key === "ArrowDown" ? 1 : -1) + POS.sug.length) % POS.sug.length;
      $$("#pos-sug .sug").forEach((d, i) => d.classList.toggle("sel", i === POS.selSug));
    } else if (e.key === "Escape") { cod.value = ""; $("#pos-sug").classList.add("oculto"); POS.sug = []; }
  };
  cod.onblur = () => setTimeout(() => $("#pos-sug")?.classList.add("oculto"), 150);

  const peso = $("#pos-peso");
  peso.onkeydown = e => {
    if (e.key === "Enter") {
      e.preventDefault();
      const kg = parseFloat(peso.value.replace(",", "."));
      if (!(kg > 0)) { sonar("error"); toast("Escriba el peso en kg (ej: 0.350)", true); return; }
      agregarAlCarro(POS.pesoDe, kg);
      cerrarPeso();
    } else if (e.key === "Escape") cerrarPeso();
  };

  $("#pos-cobrar").onclick = abrirCobro;
  $("#pos-anular").onclick = anularVentaActual;
  $("#pos-poner-espera").onclick = ponerEnEspera;
  $("#pos-ver-espera").onclick = verEspera;
  $("#pp-cerrar").onclick = cerrarCobro;
  $("#pp-guardar").onclick = finalizarVenta;
  $$(".pp-op").forEach(b => b.onclick = () => elegirTipo(b.dataset.op));
  $("#pos-pago").onclick = e => { if (e.target.id === "pos-pago") $("#pp-input").focus(); };

  const pin = $("#pp-input");
  pin.onkeydown = e => {
    if (e.key === "Enter") { e.preventDefault(); entradaPago(pin.value); }
    else if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      if (POS.paso !== "opcion") { POS.paso = "opcion"; POS.tipoSel = null; pintarPago(); } else cerrarCobro();
    }
  };
}

// Atajos globales del punto de venta (se registran una sola vez)
document.addEventListener("keydown", e => {
  if (Estado.vista !== "vender" || !$("#pos-body") || !$("#modal").classList.contains("oculto")) return;
  if (e.key === "F10") { e.preventDefault(); if ($("#pos-pago").classList.contains("oculto")) abrirCobro(); else $("#pp-input").focus(); }
  else if (e.key === "F8") { e.preventDefault(); anularVentaActual(); }
  else if (e.key === "F4") { e.preventDefault(); if ($("#pos-pago").classList.contains("oculto")) ponerEnEspera(); }
  else if (e.key === "F6") { e.preventDefault(); if ($("#pos-pago").classList.contains("oculto")) verEspera(); }
});

/* =========================================================
   PROVEEDORES
   ========================================================= */
let pendientesCache = [];
const deudaProveedor = id => red2(sumar(pendientesCache.filter(c => c.proveedorId === id), c => c.saldoUsd));
const filtrosProv = { texto: "" };

async function vistaProveedores() {
  $("#vista").innerHTML = `
    <div class="grid-tarjetas" id="prov-kpis"></div>
    <div class="barra-herr">
      <input id="prov-buscar" class="buscador" placeholder="🔍 Buscar proveedor por nombre o RIF" value="${esc(filtrosProv.texto)}">
      <button class="btn btn-primario" id="prov-nuevo">+ Nuevo proveedor</button>
    </div>
    <div class="tarjeta sin-pad"><div class="tabla-wrap"><table class="tabla-prov">
      <thead><tr><th>Proveedor</th><th>RIF</th><th>Teléfono</th><th class="num">Por pagar</th><th></th></tr></thead>
      <tbody id="prov-body"><tr><td colspan="5"><div class="spinner" style="margin:20px auto"></div></td></tr></tbody>
    </table></div></div>`;
  pendientesCache = await Store.comprasPendientes().catch(() => []);

  const pintar = () => {
    if (!$("#prov-body")) return;
    const activos = Estado.proveedores.filter(p => p.activo !== false);
    const t = normal(filtrosProv.texto);
    const lista = Estado.proveedores.filter(p => !t || normal(p.nombre).includes(t) || normal(p.rif).includes(t))
      .sort((a, b) => (b.activo !== false) - (a.activo !== false) || deudaProveedor(b.id) - deudaProveedor(a.id) || a.nombre.localeCompare(b.nombre));
    const deudaTotal = sumar(pendientesCache, c => c.saldoUsd);
    $("#prov-kpis").innerHTML = `
      <div class="tarjeta kpi lavanda"><small>Proveedores</small><strong>${activos.length}</strong><span>activos</span></div>
      <div class="tarjeta kpi ${deudaTotal > 0 ? "rosa" : "verde"}"><small>Total por pagar</small><strong>${fmtUsd(deudaTotal)}</strong><span>${tasaHoy() ? fmtBs(deudaTotal * tasaHoy()) : ""}</span></div>
      <div class="tarjeta kpi amarillo"><small>Facturas a crédito pendientes</small><strong>${pendientesCache.length}</strong><span>con saldo</span></div>`;
    $("#prov-body").innerHTML = lista.length ? lista.map(p => {
      const d = deudaProveedor(p.id);
      return `<tr class="${p.activo === false ? "inactivo" : ""}">
        <td><b>${esc(p.nombre)}</b>${p.contacto ? `<br><small class="sub">${esc(p.contacto)}</small>` : ""}${p.activo === false ? ` <span class="estado off">Inactivo</span>` : ""}</td>
        <td>${esc(p.rif || "—")}</td>
        <td>${p.telefono ? `<a href="tel:${esc(p.telefono)}">${esc(p.telefono)}</a>` : "—"}</td>
        <td class="num">${d > 0 ? `<b class="neg">${fmtUsd(d)}</b>` : `<span class="sub">—</span>`}</td>
        <td class="acciones-fila">
          <button class="btn btn-sm btn-secundario" data-hist="${p.id}" title="Compras y deudas">📋 Compras</button>
          <button class="btn btn-sm btn-secundario" data-editar="${p.id}" title="Editar">✏️</button>
        </td></tr>`;
    }).join("") : `<tr><td colspan="5" class="vacio">${Estado.proveedores.length ? "Sin resultados." : "Aún no hay proveedores. Pulsa <b>+ Nuevo proveedor</b>."}</td></tr>`;
    $$("[data-editar]").forEach(b => b.onclick = () => modalProveedor(b.dataset.editar));
    $$("[data-hist]").forEach(b => b.onclick = () => modalHistorialProveedor(b.dataset.hist));
  };
  Estado.repintar = pintar;
  pintar();
  $("#prov-buscar").oninput = e => { filtrosProv.texto = e.target.value; pintar(); };
  $("#prov-nuevo").onclick = () => modalProveedor();
}

function modalProveedor(id = null, alCrear = null) {
  const p = id ? Estado.proveedores.find(x => x.id === id) : {};
  abrirModal(`
    <div class="modal-cab"><h3>${id ? "Editar proveedor" : "Nuevo proveedor"}</h3><button class="btn-icono" data-cerrar>✕</button></div>
    <form id="form-prov">
      <label>Nombre o razón social<input id="pv-nombre" required value="${esc(p.nombre || "")}" placeholder="Ej: DISTRIBUIDORA LOS ANDES C.A."></label>
      <div class="fila-form">
        <label>RIF<input id="pv-rif" value="${esc(p.rif || "")}" placeholder="J-00000000-0"></label>
        <label>Teléfono<input id="pv-tel" value="${esc(p.telefono || "")}" placeholder="0414-0000000"></label>
      </div>
      <div class="fila-form">
        <label>Persona de contacto / vendedor<input id="pv-contacto" value="${esc(p.contacto || "")}"></label>
        <label>Días de visita o despacho<input id="pv-dias" value="${esc(p.dias || "")}" placeholder="Ej: martes y viernes"></label>
      </div>
      <label>Dirección<input id="pv-dir" value="${esc(p.direccion || "")}"></label>
      <label>Notas<input id="pv-notas" value="${esc(p.notas || "")}" placeholder="Qué productos trae, condiciones de crédito…"></label>
      <div class="acciones modal-pie">
        ${id ? `<button type="button" class="btn btn-peligro" id="pv-estado">${p.activo === false ? "Reactivar" : "Desactivar"}</button>` : ""}
        <span style="flex:1"></span>
        <button type="button" class="btn btn-fantasma" data-cerrar>Cancelar</button>
        <button class="btn btn-primario">${id ? "Guardar cambios" : "Registrar proveedor"}</button>
      </div>
    </form>`, 600);
  if (id) $("#pv-estado").onclick = async () => {
    try { await Store.actualizarProveedor(id, { activo: p.activo === false }); toast("Proveedor actualizado"); cerrarModal(); }
    catch (e) { toast(traducirError(e), true); }
  };
  $("#form-prov").onsubmit = async e => {
    e.preventDefault();
    const datos = {
      nombre: $("#pv-nombre").value.trim().toUpperCase(), rif: $("#pv-rif").value.trim().toUpperCase(),
      telefono: $("#pv-tel").value.trim(), contacto: $("#pv-contacto").value.trim(), dias: $("#pv-dias").value.trim(),
      direccion: $("#pv-dir").value.trim(), notas: $("#pv-notas").value.trim()
    };
    if (!datos.nombre) return toast("El nombre es obligatorio", true);
    const dup = Estado.proveedores.find(x => x.id !== id && ((datos.rif && normal(x.rif) === normal(datos.rif)) || normal(x.nombre) === normal(datos.nombre)));
    if (dup) return toast(`Ya existe el proveedor "${dup.nombre}"`, true);
    try {
      if (id) { await Store.actualizarProveedor(id, datos); toast("Cambios guardados ✔"); cerrarModal(); }
      else {
        const nuevoId = await Store.crearProveedor(datos);
        toast("Proveedor registrado ✔"); cerrarModal();
        if (alCrear) setTimeout(() => alCrear(nuevoId), 50);
      }
    } catch (err) { toast(traducirError(err), true); }
  };
}

async function modalHistorialProveedor(id) {
  const p = Estado.proveedores.find(x => x.id === id);
  abrirModal(`<div class="modal-cab"><h3>${esc(p.nombre)}</h3><button class="btn-icono" data-cerrar>✕</button></div><div class="spinner" style="margin:20px auto"></div>`, 820);
  const compras = (await Store.comprasDeProveedor(id).catch(() => [])).sort((a, b) => b.dia.localeCompare(a.dia));
  const deuda = sumar(compras, c => c.saldoUsd), total = sumar(compras, c => c.totalUsd);
  $("#modal-caja").innerHTML = `
    <div class="modal-cab"><h3>${esc(p.nombre)}</h3><button class="btn-icono" data-cerrar>✕</button></div>
    <p class="sub" style="margin:-6px 0 14px">${esc(p.rif || "")} ${p.telefono ? "· " + esc(p.telefono) : ""} ${p.dias ? "· Visita: " + esc(p.dias) : ""}</p>
    <div class="grid-tarjetas" style="grid-template-columns:repeat(3,1fr)">
      <div class="tarjeta kpi cielo"><small>Compras registradas</small><strong>${compras.length}</strong></div>
      <div class="tarjeta kpi verde"><small>Total comprado</small><strong>${fmtUsd(total)}</strong></div>
      <div class="tarjeta kpi ${deuda > 0 ? "rosa" : "verde"}"><small>Por pagar</small><strong>${fmtUsd(deuda)}</strong></div>
    </div>
    <div class="tabla-wrap"><table>
      <thead><tr><th>Fecha</th><th>Factura</th><th>Condición</th><th class="num">Total</th><th class="num">Saldo</th><th></th></tr></thead>
      <tbody>${compras.length ? compras.map(c => `<tr>
        <td>${fechaCorta(c.dia)}</td><td>${esc(c.factura || "s/n")}</td>
        <td><span class="estado ${c.condicion === "credito" ? "off" : "on"}">${c.condicion === "credito" ? "Crédito" : "Contado"}</span></td>
        <td class="num">${fmtUsd(c.totalUsd)}</td>
        <td class="num">${c.saldoUsd > 0 ? `<b class="neg">${fmtUsd(c.saldoUsd)}</b>` : "✔"}</td>
        <td class="acciones-fila">${c.saldoUsd > 0 ? `<button class="btn btn-sm btn-primario" data-abonar="${c.id}">Abonar</button>` : ""}
          <button class="btn btn-sm btn-secundario" data-ver="${c.id}">Ver</button></td>
      </tr>`).join("") : `<tr><td colspan="6" class="vacio">Sin compras registradas a este proveedor.</td></tr>`}</tbody>
    </table></div>`;
  $$("[data-cerrar]", $("#modal")).forEach(b => b.onclick = cerrarModal);
  const volver = () => modalHistorialProveedor(id);
  $$("[data-abonar]").forEach(b => b.onclick = () => modalAbono(compras.find(c => c.id === b.dataset.abonar), volver));
  $$("[data-ver]").forEach(b => b.onclick = () => modalDetalleCompra(compras.find(c => c.id === b.dataset.ver), volver));
}

function modalAbono(c, alTerminar) {
  abrirModal(`
    <div class="modal-cab"><h3>Registrar abono</h3><button class="btn-icono" data-cerrar>✕</button></div>
    <p class="sub" style="margin-bottom:14px"><b>${esc(c.proveedorNombre)}</b> · Fact. ${esc(c.factura || "s/n")} · Saldo: <b class="neg">${fmtUsd(c.saldoUsd)}</b></p>
    <form id="form-abono">
      <div class="fila-form">
        <label>Monto en $<input type="number" id="ab-monto" step="0.01" min="0.01" max="${c.saldoUsd}" required value="${c.saldoUsd.toFixed(2)}"></label>
        <label>Forma de pago
          <select id="ab-metodo"><option>Efectivo $</option><option>Efectivo Bs</option><option>Transferencia</option><option>Pago móvil</option><option>Zelle</option></select>
        </label>
      </div>
      <p class="nota" id="ab-bs"></p>
      <label>Nota (opcional)<input id="ab-nota" placeholder="Referencia, quién recibió…"></label>
      <div class="acciones modal-pie"><span style="flex:1"></span>
        <button type="button" class="btn btn-fantasma" data-cerrar>Cancelar</button>
        <button class="btn btn-primario">Guardar abono</button>
      </div>
    </form>`, 480);
  const eq = () => $("#ab-bs").textContent = tasaHoy() ? `Equivale a ${fmtBs($("#ab-monto").value * tasaHoy())} con la tasa de hoy.` : "";
  $("#ab-monto").oninput = eq; eq();
  $("#form-abono").onsubmit = async e => {
    e.preventDefault();
    const monto = red2($("#ab-monto").value);
    if (!(monto > 0) || monto > c.saldoUsd + 0.001) return toast("El monto debe ser mayor a 0 y no superar el saldo", true);
    try {
      await Store.abonarCompra(c.id, { dia: hoyISO(), montoUsd: monto, metodo: $("#ab-metodo").value, nota: $("#ab-nota").value.trim(), tasa: tasaHoy() || null, usuario: Estado.usuario.nombre });
      toast("Abono registrado ✔");
      pendientesCache = await Store.comprasPendientes().catch(() => pendientesCache);
      if (alTerminar) alTerminar(); else cerrarModal();
      if (Estado.repintar) Estado.repintar();
    } catch (err) { toast(traducirError(err), true); }
  };
}

function modalDetalleCompra(c, alVolver = null) {
  const mon = c.moneda === "BS" ? "Bs" : "$";
  abrirModal(`
    <div class="modal-cab"><h3>Compra · Fact. ${esc(c.factura || "s/n")}</h3><button class="btn-icono" data-cerrar>✕</button></div>
    <p class="sub" style="margin:-6px 0 12px"><b>${esc(c.proveedorNombre)}</b> · ${fechaCorta(c.dia)} · ${c.condicion === "credito" ? "Crédito" : "Contado"} · Factura en ${mon} · Tasa ${fmtNum(c.tasa)} · Registró: ${esc(c.usuario || "")}</p>
    <div class="tabla-wrap"><table>
      <thead><tr><th>Código</th><th>Producto</th><th class="num">Cantidad</th><th class="num">Costo unit.</th><th class="num">IVA</th><th class="num">Total $</th></tr></thead>
      <tbody>${c.items.map(i => `<tr><td><span class="codigo">${esc(i.codigo)}</span></td><td>${esc(i.nombre)}</td>
        <td class="num">${fmtCant(i.cantidad, i.unidad)}</td><td class="num">${mon === "Bs" ? fmtBs(i.costo) : fmtUsd(i.costo)}</td>
        <td class="num">${i.iva ? fmtUsd(i.ivaUsd) : "Exento"}</td><td class="num"><b>${fmtUsd(i.totalUsd)}</b></td></tr>`).join("")}</tbody>
    </table></div>
    <div class="totales-compra">
      <div><small>Subtotal</small><b>${fmtUsd(c.subtotalUsd)}</b></div>
      <div><small>IVA</small><b>${fmtUsd(c.ivaUsd)}</b></div>
      <div><small>Total</small><b>${fmtUsd(c.totalUsd)}</b><span>${fmtBs(c.totalBs)}</span></div>
      <div class="${c.saldoUsd > 0 ? "mal" : "ok"}"><small>Saldo</small><b>${fmtUsd(c.saldoUsd)}</b></div>
    </div>
    ${(c.abonos || []).length ? `<h4 class="sub-titulo">Abonos</h4><ul class="lista-hist">${c.abonos.map(a => `<li><span>${fechaCorta(a.dia)} · ${esc(a.metodo)} ${a.nota ? "· " + esc(a.nota) : ""}</span><b>${fmtUsd(a.montoUsd)}</b></li>`).join("")}</ul>` : ""}
    <div class="acciones modal-pie"><span style="flex:1"></span>
      ${alVolver ? `<button class="btn btn-fantasma" id="dc-volver">← Volver</button>` : ""}
      ${c.saldoUsd > 0 ? `<button class="btn btn-primario" id="dc-abonar">Registrar abono</button>` : ""}
    </div>`, 820);
  if (alVolver) $("#dc-volver").onclick = alVolver;
  if (c.saldoUsd > 0) $("#dc-abonar").onclick = () => modalAbono(c, alVolver || (() => { cerrarModal(); if (Estado.repintar) Estado.repintar(); }));
}

/* =========================================================
   COMPRAS (entrada de mercancía por factura)
   ========================================================= */
const BORRADOR_KEY = "abastoGFL_compraBorrador";
const compraVacia = () => ({ proveedorId: "", factura: "", dia: hoyISO(), condicion: "contado", moneda: "USD", tasa: tasaHoy() || "", items: [] });
let compra = null;
const guardarBorrador = () => { try { localStorage.setItem(BORRADOR_KEY, JSON.stringify(compra)); } catch {} };
const cargarBorrador = () => { try { compra = JSON.parse(localStorage.getItem(BORRADOR_KEY)) || compraVacia(); } catch { compra = compraVacia(); } };
let pestanaCompras = "nueva";
const filtrosCompras = nuevoPeriodo("mes");

function calcItemCompra(it) {
  const tasa = Number(compra.tasa) || 0;
  const costoUsd = compra.moneda === "BS" ? (tasa ? it.costo / tasa : 0) : Number(it.costo || 0);
  const subtotalUsd = costoUsd * it.cantidad, ivaUsd = it.iva ? subtotalUsd * pctIva() / 100 : 0;
  return { costoUsd: +costoUsd.toFixed(4), subtotalUsd: red2(subtotalUsd), ivaUsd: red2(ivaUsd), totalUsd: red2(subtotalUsd + ivaUsd) };
}

function vistaCompras() {
  $("#vista").innerHTML = `
    <div class="tabs tabs-vista">
      <button class="tab ${pestanaCompras === "nueva" ? "activo" : ""}" data-pest="nueva">🧾 Registrar compra</button>
      <button class="tab ${pestanaCompras === "hist" ? "activo" : ""}" data-pest="hist">📚 Historial de compras</button>
    </div>
    <div id="compras-cont"></div>`;
  $$("[data-pest]").forEach(b => b.onclick = () => { pestanaCompras = b.dataset.pest; vistaCompras(); });
  if (pestanaCompras === "nueva") pintarNuevaCompra(); else pintarHistorialCompras();
}

function opcionesProveedores(sel) {
  const l = Estado.proveedores.filter(p => p.activo !== false || p.id === sel).sort((a, b) => a.nombre.localeCompare(b.nombre));
  return `<option value="">— Seleccione el proveedor —</option>` + l.map(p => `<option value="${p.id}" ${p.id === sel ? "selected" : ""}>${esc(p.nombre)}</option>`).join("");
}

function pintarNuevaCompra() {
  cargarBorrador();
  if (!compra.tasa && tasaHoy()) compra.tasa = tasaHoy();
  $("#compras-cont").innerHTML = `
    <div class="tarjeta">
      <h3>Datos de la factura</h3>
      <div class="fila-form fila-compra">
        <label>Proveedor
          <div class="input-boton"><select id="cp-prov">${opcionesProveedores(compra.proveedorId)}</select>
          <button type="button" class="btn btn-secundario btn-sm" id="cp-prov-nuevo" title="Nuevo proveedor">+ Nuevo</button></div>
        </label>
        <label>N° de factura / nota<input id="cp-fact" value="${esc(compra.factura)}" placeholder="Ej: 000123"></label>
        <label>Fecha<input type="date" id="cp-dia" value="${compra.dia}" max="${hoyISO()}"></label>
      </div>
      <div class="fila-form fila-compra">
        <div class="campo"><span class="etq">Condición</span>
          <div class="segmento">
            <label><input type="radio" name="cp-cond" value="contado" ${compra.condicion !== "credito" ? "checked" : ""}><span>Contado</span></label>
            <label><input type="radio" name="cp-cond" value="credito" ${compra.condicion === "credito" ? "checked" : ""}><span>Crédito</span></label>
          </div></div>
        <div class="campo"><span class="etq">Costos de la factura en</span>
          <div class="segmento">
            <label><input type="radio" name="cp-mon" value="USD" ${compra.moneda !== "BS" ? "checked" : ""}><span>Dólares $</span></label>
            <label><input type="radio" name="cp-mon" value="BS" ${compra.moneda === "BS" ? "checked" : ""}><span>Bolívares Bs</span></label>
          </div></div>
        <label>Tasa BCV de la factura<input type="number" id="cp-tasa" step="0.0001" min="0" value="${compra.tasa}"></label>
      </div>
    </div>

    <div class="tarjeta" style="margin-top:16px">
      <div class="cab-tarjeta">
        <h3>Productos recibidos</h3>
        <button class="btn btn-secundario btn-sm" id="cp-prod-nuevo">+ Producto nuevo</button>
      </div>
      <div class="pos-campo" style="margin-bottom:12px">
        <input id="cp-buscar" class="buscador" autocomplete="off" placeholder="🔍 Escanee o escriba el código / nombre del producto y Enter">
        <div id="cp-sug" class="pos-sug oculto"></div>
      </div>
      <div class="tabla-wrap"><table class="tabla-compra">
        <thead><tr><th>Código</th><th>Producto</th><th class="num">Cantidad</th><th class="num" id="cp-th-costo">Costo unit. sin IVA</th><th class="num">IVA</th><th class="num">Total $</th><th class="num">Costo antes</th><th></th></tr></thead>
        <tbody id="cp-body"></tbody>
      </table></div>
    </div>

    <div class="pie-compra">
      <div class="totales-compra" id="cp-totales"></div>
      <div class="acciones">
        <button class="btn btn-fantasma" id="cp-limpiar">Limpiar</button>
        <button class="btn btn-primario btn-grande" id="cp-guardar">✔ Guardar compra</button>
      </div>
    </div>
    <div id="cp-resultado"></div>`;

  const leerCab = () => {
    compra.proveedorId = $("#cp-prov").value; compra.factura = $("#cp-fact").value.trim(); compra.dia = $("#cp-dia").value || hoyISO();
    compra.condicion = $("[name=cp-cond]:checked").value; compra.moneda = $("[name=cp-mon]:checked").value; compra.tasa = Number($("#cp-tasa").value) || "";
    guardarBorrador();
  };
  ["#cp-prov", "#cp-fact", "#cp-dia"].forEach(s => $(s).onchange = leerCab);
  $$("[name=cp-cond]").forEach(r => r.onchange = leerCab);
  $$("[name=cp-mon]").forEach(r => r.onchange = () => {
    const antes = compra.moneda; leerCab();
    const t = Number(compra.tasa);
    if (t && antes !== compra.moneda) compra.items.forEach(i => i.costo = compra.moneda === "BS" ? red2(i.costo * t) : +(i.costo / t).toFixed(4));
    guardarBorrador(); pintarItemsCompra();
  });
  $("#cp-tasa").oninput = () => { leerCab(); pintarItemsCompra(false); };
  $("#cp-prov-nuevo").onclick = () => modalProveedor(null, nuevoId => { compra.proveedorId = nuevoId; guardarBorrador(); $("#cp-prov").innerHTML = opcionesProveedores(nuevoId); });

  const agregar = p => {
    const ex = compra.items.find(i => i.productoId === p.id);
    if (ex) { ex.cantidad = +(ex.cantidad + 1).toFixed(3); }
    else {
      const t = Number(compra.tasa) || 0, cu = Number(p.costoUsd || 0);
      compra.items.push({ productoId: p.id, codigo: p.codigo, nombre: p.nombre, unidad: p.unidad, iva: !!p.iva,
        cantidad: p.unidad === "kg" ? 1 : 1, costo: compra.moneda === "BS" ? red2(cu * t) : cu, costoAnteriorUsd: cu });
    }
    guardarBorrador(); sonar("beep"); pintarItemsCompra(true, p.id);
  };
  const crearNuevo = (codigo = "") => modalProducto(null, codigo, { sinStock: true, alCrear: p => agregar(p) });
  buscadorProducto($("#cp-buscar"), $("#cp-sug"), agregar, txt => { if (confirm(`El código "${txt}" no existe. ¿Registrar un producto nuevo?`)) crearNuevo(txt); });
  $("#cp-prod-nuevo").onclick = () => crearNuevo();
  $("#cp-limpiar").onclick = () => { if (!compra.items.length || confirm("¿Borrar esta compra en proceso?")) { localStorage.removeItem(BORRADOR_KEY); pintarNuevaCompra(); } };
  $("#cp-guardar").onclick = guardarCompra;

  Estado.repintar = () => { if ($("#cp-prov") && document.activeElement !== $("#cp-prov")) $("#cp-prov").innerHTML = opcionesProveedores(compra.proveedorId); };
  pintarItemsCompra();
  $("#cp-buscar").focus();
}

function pintarItemsCompra(repintarFilas = true, resaltar = null) {
  const mon = compra.moneda === "BS" ? "Bs" : "$";
  $("#cp-th-costo").textContent = `Costo unit. sin IVA (${mon})`;
  if (repintarFilas) {
    $("#cp-body").innerHTML = compra.items.length ? compra.items.map((it, i) => `
      <tr data-i="${i}" class="${it.productoId === resaltar ? "resalta" : ""}">
        <td><span class="codigo">${esc(it.codigo)}</span></td>
        <td><b>${esc(it.nombre)}</b></td>
        <td class="num"><input type="number" class="in-cant" min="0" step="${it.unidad === "kg" ? "0.001" : "1"}" value="${it.cantidad}"><small class="sub"> ${it.unidad}</small></td>
        <td class="num"><input type="number" class="in-costo" min="0" step="0.0001" value="${it.costo}"></td>
        <td class="num"><label class="check"><input type="checkbox" class="in-iva" ${it.iva ? "checked" : ""}> ${pctIva()}%</label></td>
        <td class="num"><b class="tot"></b></td>
        <td class="num antes"></td>
        <td><button class="btn-quitar" data-q="${i}">✕</button></td>
      </tr>`).join("") : `<tr><td colspan="8" class="vacio">Escanee o busque los productos de la factura.</td></tr>`;
    $$("#cp-body tr[data-i]").forEach(tr => {
      const it = compra.items[tr.dataset.i];
      $(".in-cant", tr).oninput = e => { it.cantidad = Number(e.target.value) || 0; guardarBorrador(); pintarItemsCompra(false); };
      $(".in-costo", tr).oninput = e => { it.costo = Number(e.target.value) || 0; guardarBorrador(); pintarItemsCompra(false); };
      $(".in-iva", tr).onchange = e => { it.iva = e.target.checked; guardarBorrador(); pintarItemsCompra(false); };
      $$("input[type=number]", tr).forEach(inp => { inp.onfocus = () => inp.select(); inp.onkeydown = e => { if (e.key === "Enter") $("#cp-buscar").focus(); }; });
    });
    $$("[data-q]").forEach(b => b.onclick = () => { compra.items.splice(b.dataset.q, 1); guardarBorrador(); pintarItemsCompra(); });
    const r = $("#cp-body tr.resalta");
    if (r) { r.scrollIntoView({ block: "nearest" }); $(".in-cant", r).focus(); }
  }
  // Totales y comparación con el costo anterior
  let sub = 0, iva = 0;
  $$("#cp-body tr[data-i]").forEach(tr => {
    const it = compra.items[tr.dataset.i], c = calcItemCompra(it);
    sub += c.subtotalUsd; iva += c.ivaUsd;
    $(".tot", tr).textContent = fmtUsd(c.totalUsd);
    const ant = Number(it.costoAnteriorUsd || 0), dif = ant ? (c.costoUsd - ant) / ant * 100 : null;
    $(".antes", tr).innerHTML = ant ? `${fmtUsd(ant)}<br><small class="${dif > 0.05 ? "neg" : dif < -0.05 ? "pos" : "sub"}">${dif > 0.05 ? "▲ " : dif < -0.05 ? "▼ " : ""}${Math.abs(dif) < 0.05 ? "igual" : Math.abs(dif).toFixed(1) + " %"}</small>` : `<small class="sub">nuevo</small>`;
  });
  const tot = red2(sub + iva), t = Number(compra.tasa) || 0;
  $("#cp-totales").innerHTML = `
    <div><small>Productos</small><b>${compra.items.length}</b></div>
    <div><small>Subtotal</small><b>${fmtUsd(sub)}</b></div>
    <div><small>IVA ${pctIva()}%</small><b>${fmtUsd(iva)}</b></div>
    <div class="ok"><small>Total factura</small><b>${fmtUsd(tot)}</b><span>${t ? fmtBs(tot * t) : "sin tasa"}</span></div>`;
}

async function guardarCompra() {
  const btn = $("#cp-guardar");
  const prov = Estado.proveedores.find(p => p.id === compra.proveedorId);
  const t = Number(compra.tasa);
  if (!prov) return toast("Seleccione el proveedor", true);
  if (!compra.items.length) return toast("Agregue al menos un producto", true);
  if (!(t > 0)) return toast("Escriba la tasa BCV de la factura", true);
  if (compra.items.some(i => !(i.cantidad > 0))) return toast("Hay productos con cantidad en 0", true);
  if (compra.items.some(i => !(i.costo > 0)) && !confirm("Hay productos con costo 0. ¿Guardar de todas formas?")) return;

  const items = compra.items.map(i => ({ productoId: i.productoId, codigo: i.codigo, nombre: i.nombre, unidad: i.unidad, iva: !!i.iva,
    cantidad: i.cantidad, costo: i.costo, costoAnteriorUsd: Number(i.costoAnteriorUsd || 0), ...calcItemCompra(i) }));
  const subtotalUsd = red2(sumar(items, i => i.subtotalUsd)), ivaUsd = red2(sumar(items, i => i.ivaUsd)), totalUsd = red2(subtotalUsd + ivaUsd);
  const doc = { proveedorId: prov.id, proveedorNombre: prov.nombre, factura: compra.factura, dia: compra.dia, condicion: compra.condicion,
    moneda: compra.moneda, tasa: t, items, subtotalUsd, ivaUsd, totalUsd, totalBs: red2(totalUsd * t),
    saldoUsd: compra.condicion === "credito" ? totalUsd : 0, abonos: [], usuario: Estado.usuario.nombre };

  btn.disabled = true;
  try {
    await Store.registrarCompra(doc);
    // ¿Qué precios quedaron en pérdida con el costo nuevo?
    const cambios = items.filter(i => Math.abs(i.costoUsd - i.costoAnteriorUsd) > 0.00005);
    const perdida = items.filter(i => { const p = Estado.productos.find(x => x.id === i.productoId) || {}; const m = margen({ ...p, costoUsd: i.costoUsd, iva: i.iva }); return m != null && m < 0; });
    localStorage.removeItem(BORRADOR_KEY);
    sonar("ok");
    pintarNuevaCompra();
    $("#cp-resultado").innerHTML = `
      <div class="tarjeta aviso-compra ${perdida.length ? "mal" : "ok"}">
        <h3>✔ Compra guardada · ${esc(prov.nombre)} · ${fmtUsd(totalUsd)}${doc.condicion === "credito" ? " (a crédito)" : ""}</h3>
        <p>Se sumaron ${items.length} producto(s) al inventario. ${cambios.length ? `Cambió el costo de <b>${cambios.length}</b> producto(s).` : "Los costos no cambiaron."}</p>
        ${perdida.length ? `<p class="neg"><b>⚠ ${perdida.length} producto(s) quedaron vendiéndose por debajo del costo:</b> ${perdida.map(i => esc(i.nombre)).join(", ")}</p>` : ""}
        ${cambios.length ? `<button class="btn btn-primario btn-sm" data-ir="precios">Revisar Lista de Precios</button>` : ""}
      </div>`;
    $$("[data-ir]").forEach(b => b.onclick = () => { filtrosPre.negativos = perdida.length > 0; irA("precios"); });
  } catch (err) { toast(traducirError(err), true); btn.disabled = false; }
}

async function pintarHistorialCompras() {
  const f = filtrosCompras;
  $("#compras-cont").innerHTML = `
    ${htmlPeriodo(f)}
    <div class="grid-tarjetas" id="ch-kpis"><div class="spinner" style="margin:20px auto"></div></div>
    <div class="tarjeta sin-pad"><div class="tabla-wrap"><table>
      <thead><tr><th>Fecha</th><th>Proveedor</th><th>Factura</th><th>Condición</th><th class="num">Total $</th><th class="num">Total Bs</th><th class="num">Saldo</th><th></th></tr></thead>
      <tbody id="ch-body"></tbody></table></div></div>`;
  conectarPeriodo(f, pintarHistorialCompras);
  const [lista, pend] = await Promise.all([Store.comprasRango(f.desde, f.hasta).catch(() => []), Store.comprasPendientes().catch(() => [])]);
  pendientesCache = pend;
  lista.sort((a, b) => b.dia.localeCompare(a.dia));
  $("#ch-kpis").innerHTML = `
    <div class="tarjeta kpi cielo"><small>Compras del período</small><strong>${fmtUsd(sumar(lista, c => c.totalUsd))}</strong><span>${fmtBs(sumar(lista, c => c.totalBs))}</span></div>
    <div class="tarjeta kpi verde"><small>Facturas</small><strong>${lista.length}</strong><span>${textoPeriodo(f)}</span></div>
    <div class="tarjeta kpi amarillo"><small>IVA pagado</small><strong>${fmtUsd(sumar(lista, c => c.ivaUsd))}</strong><span>en el período</span></div>
    <div class="tarjeta kpi ${pend.length ? "rosa" : "verde"}"><small>Por pagar (total)</small><strong>${fmtUsd(sumar(pend, c => c.saldoUsd))}</strong><span>${pend.length} factura(s) a crédito</span></div>`;
  $("#ch-body").innerHTML = lista.length ? lista.map(c => `<tr>
    <td>${fechaCorta(c.dia)}</td><td><b>${esc(c.proveedorNombre)}</b></td><td>${esc(c.factura || "s/n")}</td>
    <td><span class="estado ${c.condicion === "credito" ? "off" : "on"}">${c.condicion === "credito" ? "Crédito" : "Contado"}</span></td>
    <td class="num"><b>${fmtUsd(c.totalUsd)}</b></td><td class="num">${fmtBs(c.totalBs)}</td>
    <td class="num">${c.saldoUsd > 0 ? `<b class="neg">${fmtUsd(c.saldoUsd)}</b>` : "✔"}</td>
    <td><button class="btn btn-sm btn-secundario" data-ver="${c.id}">Ver</button></td></tr>`).join("")
    : `<tr><td colspan="8" class="vacio">No hay compras en este período.</td></tr>`;
  $$("[data-ver]").forEach(b => b.onclick = () => modalDetalleCompra(lista.find(c => c.id === b.dataset.ver)));
  Estado.repintar = () => { if ($("#modal").classList.contains("oculto")) pintarHistorialCompras(); };
}

/* =========================================================
   AUTOCONSUMO Y MERMAS
   Sale del inventario al costo (no es venta) y se descuenta de la utilidad
   ========================================================= */
const filtrosSal = nuevoPeriodo("mes");
let salida = { tipo: "autoconsumo", producto: null };

function vistaAutoconsumo() {
  $("#vista").innerHTML = `
    <div class="tarjeta">
      <h3>Registrar salida de mercancía</h3>
      <div class="segmento segmento-grande" style="margin-bottom:14px">
        ${Object.entries(TIPOS_SALIDA).map(([k, t]) => `<label><input type="radio" name="sal-tipo" value="${k}" ${salida.tipo === k ? "checked" : ""}><span>${t.ico} ${t.nombre}</span></label>`).join("")}
      </div>
      <div class="pos-campo" style="margin-bottom:12px">
        <input id="sal-buscar" class="buscador" autocomplete="off" placeholder="🔍 Escanee o escriba el código / nombre del producto">
        <div id="sal-sug" class="pos-sug oculto"></div>
      </div>
      <div id="sal-form"></div>
    </div>
    ${htmlPeriodo(filtrosSal)}
    <div class="grid-tarjetas" id="sal-kpis"></div>
    <div class="tarjeta sin-pad"><div class="tabla-wrap"><table>
      <thead><tr><th>Fecha</th><th>Tipo</th><th>Producto</th><th class="num">Cantidad</th><th class="num">Costo $</th><th class="num">Costo Bs</th><th>Nota</th></tr></thead>
      <tbody id="sal-body"></tbody></table></div></div>
    <p class="nota">El autoconsumo y las mermas se descuentan del inventario <b>al costo</b> y se restan de la utilidad en <b>Utilidad y Reportes</b>.</p>`;

  $$("[name=sal-tipo]").forEach(r => r.onchange = () => { salida.tipo = r.value; pintarFormSalida(); });
  buscadorProducto($("#sal-buscar"), $("#sal-sug"), p => { salida.producto = p; pintarFormSalida(); });
  conectarPeriodo(filtrosSal, vistaAutoconsumo);
  pintarFormSalida();
  cargarSalidas();
  Estado.repintar = null;
  $("#sal-buscar").focus();
}

function pintarFormSalida() {
  const p = salida.producto && Estado.productos.find(x => x.id === salida.producto.id), box = $("#sal-form");
  if (!p) { box.innerHTML = `<p class="sub">Seleccione el producto que sale del inventario.</p>`; return; }
  const t = TIPOS_SALIDA[salida.tipo];
  box.innerHTML = `
    <form id="form-salida" class="salida-prod">
      <div class="salida-info"><span class="codigo">${esc(p.codigo)}</span> <b>${esc(p.nombre)}</b>
        <small class="sub">· Existencia: ${fmtCant(p.stock, p.unidad)} · Costo: ${fmtUsd(costoUsdReal(p))}${p.unidad === "kg" ? "/kg" : ""}</small></div>
      <div class="fila-form">
        <label>Cantidad ${p.unidad === "kg" ? "(kg)" : "(unidades)"}<input type="number" id="sal-cant" step="${p.unidad === "kg" ? "0.001" : "1"}" min="0" required></label>
        <label>Nota (opcional)<input id="sal-nota" placeholder="${salida.tipo === "autoconsumo" ? "Ej: para la casa" : "Ej: se rompió el empaque"}"></label>
      </div>
      <div class="salida-costo" id="sal-costo"></div>
      <div class="acciones">
        <button type="button" class="btn btn-fantasma" id="sal-cancelar">Cancelar</button>
        <button class="btn btn-primario">${t.ico} Registrar ${t.nombre.toLowerCase()}</button>
      </div>
    </form>`;
  const prev = () => {
    const c = Number($("#sal-cant").value) || 0, u = costoUsdReal(p) * c;
    $("#sal-costo").innerHTML = c ? `Costo de la salida: <b>${fmtUsd(u)}</b>${tasaHoy() ? " · " + fmtBs(u * tasaHoy()) : ""}${c > p.stock ? ` <span class="neg">· supera la existencia</span>` : ""}` : "";
  };
  $("#sal-cant").oninput = prev;
  $("#sal-cant").focus();
  $("#sal-cancelar").onclick = () => { salida.producto = null; pintarFormSalida(); $("#sal-buscar").focus(); };
  $("#form-salida").onsubmit = async e => {
    e.preventDefault();
    const cant = Number($("#sal-cant").value);
    if (!(cant > 0)) return toast("Escriba la cantidad", true);
    if (cant > p.stock && !confirm("La cantidad supera la existencia registrada. ¿Registrar de todas formas?")) return;
    const cu = costoUsdReal(p), tasa = tasaHoy() || null;
    try {
      await Store.registrarSalida({ dia: hoyISO(), tipo: salida.tipo, productoId: p.id, codigo: p.codigo, nombre: p.nombre, unidad: p.unidad,
        cantidad: cant, costoUnitUsd: +cu.toFixed(4), costoUsd: red2(cu * cant), tasa, costoBs: tasa ? red2(cu * cant * tasa) : 0,
        nota: $("#sal-nota").value.trim(), usuario: Estado.usuario.nombre });
      sonar("ok"); toast(`${TIPOS_SALIDA[salida.tipo].nombre} registrado ✔`);
      salida.producto = null; pintarFormSalida(); cargarSalidas(); $("#sal-buscar").focus();
    } catch (err) { toast(traducirError(err), true); }
  };
}

async function cargarSalidas() {
  const f = filtrosSal;
  const l = (await Store.salidasRango(f.desde, f.hasta).catch(() => [])).sort((a, b) => b._t - a._t);
  if (!$("#sal-body")) return;
  $("#sal-kpis").innerHTML = Object.entries(TIPOS_SALIDA).map(([k, t]) => {
    const x = l.filter(s => s.tipo === k);
    return `<div class="tarjeta kpi ${t.color}"><small>${t.ico} ${t.nombre}</small><strong>${fmtUsd(sumar(x, s => s.costoUsd))}</strong><span>${fmtBs(sumar(x, s => s.costoBs))} · ${x.length} registro(s)</span></div>`;
  }).join("") + `<div class="tarjeta kpi cielo"><small>Total al costo</small><strong>${fmtUsd(sumar(l, s => s.costoUsd))}</strong><span>${textoPeriodo(f)}</span></div>`;
  $("#sal-body").innerHTML = l.length ? l.map(s => `<tr>
    <td>${fechaCorta(s.dia)}<br><small class="sub">${horaDe(s._t)}</small></td>
    <td><span class="estado tipo-${s.tipo}">${TIPOS_SALIDA[s.tipo]?.ico || ""} ${TIPOS_SALIDA[s.tipo]?.nombre || s.tipo}</span></td>
    <td><span class="codigo">${esc(s.codigo)}</span> ${esc(s.nombre)}</td>
    <td class="num">${fmtCant(s.cantidad, s.unidad)}</td>
    <td class="num">${fmtUsd(s.costoUsd)}</td><td class="num">${fmtBs(s.costoBs)}</td>
    <td><small>${esc(s.nota || "")}<br><span class="sub">${esc(s.usuario || "")}</span></small></td></tr>`).join("")
    : `<tr><td colspan="7" class="vacio">No hay salidas registradas en este período.</td></tr>`;
}

/* =========================================================
   UTILIDAD Y REPORTES
   Utilidad neta = ventas − costo de lo vendido − autoconsumo − mermas
   ========================================================= */
const filtrosRep = nuevoPeriodo("hoy");
let repDatos = null, repVerTodos = false;

async function vistaReportes() {
  const f = filtrosRep;
  $("#vista").innerHTML = `
    <div class="barra-herr barra-rep">${htmlPeriodo(f)}
      <span style="flex:1"></span>
      <button class="btn btn-secundario btn-sm" id="rep-csv-ventas">⬇ Ventas (Excel)</button>
      <button class="btn btn-secundario btn-sm" id="rep-csv-prod">⬇ Productos (Excel)</button>
    </div>
    <div id="rep-cont"><div class="tarjeta"><div class="spinner" style="margin:30px auto"></div></div></div>`;
  conectarPeriodo(f, vistaReportes);
  Estado.repintar = null;

  const [ventas, salidas, compras] = await Promise.all([
    Store.ventasRango(f.desde, f.hasta).catch(e => { toast(traducirError(e), true); return []; }),
    Store.salidasRango(f.desde, f.hasta).catch(() => []),
    Store.comprasRango(f.desde, f.hasta).catch(() => [])
  ]);
  if (Estado.vista !== "reportes") return;
  repDatos = { ventas: ventas.sort((a, b) => b.numero - a.numero), salidas, compras };
  pintarReporte();
  $("#rep-csv-ventas").onclick = exportarVentas;
  $("#rep-csv-prod").onclick = exportarProductos;
}

function calcularReporte() {
  const { ventas, salidas, compras } = repDatos;
  const ok = ventas.filter(v => !v.anulada);
  const usd = (bs, v) => v.tasa ? bs / v.tasa : 0;
  const r = {
    ok, anuladas: ventas.filter(v => v.anulada),
    ventasBs: sumar(ok, v => v.totalBs), ventasUsd: sumar(ok, v => v.totalUsd ?? usd(v.totalBs, v)),
    costoBs: sumar(ok, v => v.costoBs), costoUsd: sumar(ok, v => usd(v.costoBs, v)),
    brutaBs: sumar(ok, v => v.utilidadBs), brutaUsd: sumar(ok, v => usd(v.utilidadBs, v)),
    autoBs: sumar(salidas.filter(s => s.tipo === "autoconsumo"), s => s.costoBs), autoUsd: sumar(salidas.filter(s => s.tipo === "autoconsumo"), s => s.costoUsd),
    mermaBs: sumar(salidas.filter(s => s.tipo !== "autoconsumo"), s => s.costoBs), mermaUsd: sumar(salidas.filter(s => s.tipo !== "autoconsumo"), s => s.costoUsd),
    comprasUsd: sumar(compras, c => c.totalUsd), comprasBs: sumar(compras, c => c.totalBs)
  };
  r.netaBs = r.brutaBs - r.autoBs - r.mermaBs;
  r.netaUsd = r.brutaUsd - r.autoUsd - r.mermaUsd;

  // Cuadre por tipo de pago
  r.pagos = Object.entries(TIPOS_PAGO).map(([cod, t]) => {
    const ps = ok.flatMap(v => v.pagos || []).filter(p => p.codigo === cod);
    return { cod, nombre: t.nombre, moneda: t.moneda, n: ps.length, bs: sumar(ps, p => p.montoBs), monto: sumar(ps, p => p.monto) };
  });
  // Por cajero
  const caj = {};
  ok.forEach(v => { const c = caj[v.cajero] ||= { nombre: v.cajero, n: 0, bs: 0 }; c.n++; c.bs += v.totalBs; });
  r.cajeros = Object.values(caj).sort((a, b) => b.bs - a.bs);
  // Por producto
  const pr = {};
  ok.forEach(v => v.items.forEach(i => {
    const x = pr[i.productoId] ||= { codigo: i.codigo, nombre: i.nombre, unidad: i.unidad, cant: 0, ventasBs: 0, costoBs: 0, utilBs: 0, utilUsd: 0 };
    const sub = i.subtotalBs ?? i.cantidad * i.precioBs, cos = i.costoBs * i.cantidad;
    x.cant += i.cantidad; x.ventasBs += sub; x.costoBs += cos; x.utilBs += sub - cos; x.utilUsd += v.tasa ? (sub - cos) / v.tasa : 0;
  }));
  r.productos = Object.values(pr).sort((a, b) => b.utilBs - a.utilBs);
  // Por día
  const dias = {};
  ok.forEach(v => { const d = dias[v.dia] ||= { dia: v.dia, n: 0, bs: 0, util: 0 }; d.n++; d.bs += v.totalBs; d.util += v.utilidadBs; });
  salidas.forEach(s => { const d = dias[s.dia] ||= { dia: s.dia, n: 0, bs: 0, util: 0 }; d.util -= s.costoBs; });
  r.dias = Object.values(dias).sort((a, b) => b.dia.localeCompare(a.dia));
  return r;
}

function pintarReporte() {
  const r = calcularReporte(), f = filtrosRep;
  const pct = (a, b) => b ? (a / b * 100).toFixed(1) + " %" : "—";
  const prods = repVerTodos ? r.productos : r.productos.slice(0, 15);
  $("#rep-cont").innerHTML = `
    <div class="rep-neta ${r.netaBs < 0 ? "perdida" : ""}">
      <div><small>UTILIDAD NETA · ${textoPeriodo(f)}</small><strong>${fmtBs(r.netaBs)}</strong><span>${fmtUsd(r.netaUsd)} ref.</span></div>
      <div class="rep-formula">
        <div><span>Ventas</span><b>${fmtBs(r.ventasBs)}</b></div>
        <div><span>− Costo de lo vendido</span><b>${fmtBs(r.costoBs)}</b></div>
        <div class="linea"><span>= Utilidad bruta</span><b>${fmtBs(r.brutaBs)}</b></div>
        <div><span>− Autoconsumo</span><b>${fmtBs(r.autoBs)}</b></div>
        <div><span>− Mermas y vencidos</span><b>${fmtBs(r.mermaBs)}</b></div>
        <div class="linea total"><span>= Utilidad neta</span><b>${fmtBs(r.netaBs)}</b></div>
      </div>
    </div>

    <div class="grid-tarjetas">
      <div class="tarjeta kpi verde"><small>Ventas</small><strong>${fmtBs(r.ventasBs)}</strong><span>${fmtUsd(r.ventasUsd)} ref.</span></div>
      <div class="tarjeta kpi durazno"><small>Tickets</small><strong>${r.ok.length}</strong><span>Promedio ${fmtBs(r.ok.length ? r.ventasBs / r.ok.length : 0)}${r.anuladas.length ? ` · ${r.anuladas.length} anulada(s)` : ""}</span></div>
      <div class="tarjeta kpi lavanda"><small>Utilidad bruta</small><strong>${fmtBs(r.brutaBs)}</strong><span>${fmtUsd(r.brutaUsd)} · ${pct(r.brutaBs, r.costoBs)} sobre costo</span></div>
      <div class="tarjeta kpi rosa"><small>Autoconsumo + mermas</small><strong>${fmtBs(r.autoBs + r.mermaBs)}</strong><span>${fmtUsd(r.autoUsd + r.mermaUsd)} al costo</span></div>
      <div class="tarjeta kpi cielo"><small>Compras del período</small><strong>${fmtUsd(r.comprasUsd)}</strong><span>${fmtBs(r.comprasBs)} · ${repDatos.compras.length} factura(s)</span></div>
    </div>

    <div class="rep-grid">
      <div class="tarjeta">
        <h3>💳 Cuadre por tipo de pago</h3>
        <table><thead><tr><th>Tipo</th><th class="num">Operaciones</th><th class="num">Monto</th><th class="num">En Bs</th></tr></thead>
        <tbody>${r.pagos.map(p => `<tr class="${p.n ? "" : "sub"}"><td><span class="codigo">${p.cod}</span> ${p.nombre}</td><td class="num">${p.n}</td>
          <td class="num">${p.moneda === "$" ? fmtUsd(p.monto) : fmtBs(p.monto)}</td><td class="num"><b>${fmtBs(p.bs)}</b></td></tr>`).join("")}
          <tr class="fila-total"><td>Total cobrado</td><td class="num">${sumar(r.pagos, p => p.n)}</td><td></td><td class="num"><b>${fmtBs(sumar(r.pagos, p => p.bs))}</b></td></tr>
        </tbody></table>
        <p class="nota">Compara cada línea con lo que hay en caja, en el punto y en el banco.</p>
      </div>
      <div class="tarjeta">
        <h3>👤 Ventas por cajero</h3>
        <table><thead><tr><th>Cajero</th><th class="num">Tickets</th><th class="num">Total</th></tr></thead>
        <tbody>${r.cajeros.length ? r.cajeros.map(c => `<tr><td>${esc(c.nombre)}</td><td class="num">${c.n}</td><td class="num"><b>${fmtBs(c.bs)}</b></td></tr>`).join("") : `<tr><td colspan="3" class="vacio">Sin ventas.</td></tr>`}</tbody></table>
        ${r.dias.length > 1 ? `<h3 style="margin-top:18px">📅 Por día</h3>
        <table><thead><tr><th>Día</th><th class="num">Tickets</th><th class="num">Ventas</th><th class="num">Utilidad neta</th></tr></thead>
        <tbody>${r.dias.map(d => `<tr><td>${fechaCorta(d.dia)}</td><td class="num">${d.n}</td><td class="num">${fmtBs(d.bs)}</td><td class="num ${d.util < 0 ? "neg" : ""}"><b>${fmtBs(d.util)}</b></td></tr>`).join("")}</tbody></table>` : ""}
      </div>
    </div>

    <div class="tarjeta" style="margin-top:16px">
      <div class="cab-tarjeta"><h3>📦 Utilidad por producto</h3>
        ${r.productos.length > 15 ? `<button class="btn btn-sm btn-secundario" id="rep-todos">${repVerTodos ? "Ver los 15 mejores" : `Ver todos (${r.productos.length})`}</button>` : ""}</div>
      <div class="tabla-wrap"><table>
        <thead><tr><th>Código</th><th>Producto</th><th class="num">Vendido</th><th class="num">Ventas Bs</th><th class="num">Costo Bs</th><th class="num">Utilidad Bs</th><th class="num">Utilidad $</th><th class="num">% s/costo</th></tr></thead>
        <tbody>${prods.length ? prods.map(p => `<tr class="${p.utilBs < 0 ? "fila-neg" : ""}">
          <td><span class="codigo">${esc(p.codigo)}</span></td><td><b>${esc(p.nombre)}</b></td><td class="num">${fmtCant(p.cant, p.unidad)}</td>
          <td class="num">${fmtBs(p.ventasBs)}</td><td class="num">${fmtBs(p.costoBs)}</td><td class="num"><b>${fmtBs(p.utilBs)}</b></td>
          <td class="num">${fmtUsd(p.utilUsd)}</td><td class="num">${pct(p.utilBs, p.costoBs)}</td></tr>`).join("")
          : `<tr><td colspan="8" class="vacio">Sin ventas en este período.</td></tr>`}</tbody>
      </table></div>
    </div>

    <div class="tarjeta" style="margin-top:16px">
      <h3>🧾 Ventas del período (${repDatos.ventas.length})</h3>
      <div class="tabla-wrap"><table>
        <thead><tr><th>N°</th><th>Fecha</th><th>Cajero</th><th class="num">Productos</th><th class="num">Total</th><th>Pagos</th><th class="num">Utilidad</th><th></th></tr></thead>
        <tbody>${repDatos.ventas.length ? repDatos.ventas.map(v => `<tr class="${v.anulada ? "anulada" : ""}">
          <td><b>#${numVenta(v.numero)}</b>${v.anulada ? `<br><span class="estado off">Anulada</span>` : ""}</td>
          <td>${fechaCorta(v.dia)}<br><small class="sub">${horaDe(v._t)}</small></td><td>${esc(v.cajero)}</td>
          <td class="num">${v.items.length}</td><td class="num"><b>${fmtBs(v.totalBs)}</b></td>
          <td><small>${(v.pagos || []).map(p => `${p.codigo} ${p.tipo}`).join(" + ")}</small></td>
          <td class="num">${fmtBs(v.utilidadBs)}</td>
          <td class="acciones-fila"><button class="btn btn-sm btn-secundario" data-vv="${v.id}">Ver</button>
            ${v.anulada ? "" : `<button class="btn btn-sm btn-peligro" data-anular="${v.id}">Anular</button>`}</td></tr>`).join("")
          : `<tr><td colspan="8" class="vacio">Sin ventas en este período.</td></tr>`}</tbody>
      </table></div>
    </div>`;
  $("#rep-todos") && ($("#rep-todos").onclick = () => { repVerTodos = !repVerTodos; pintarReporte(); });
  $$("[data-vv]").forEach(b => b.onclick = () => modalDetalleVenta(repDatos.ventas.find(v => v.id === b.dataset.vv)));
  $$("[data-anular]").forEach(b => b.onclick = () => modalAnularVenta(repDatos.ventas.find(v => v.id === b.dataset.anular)));
}

function modalDetalleVenta(v) {
  abrirModal(`
    <div class="modal-cab"><h3>Venta #${numVenta(v.numero)} ${v.anulada ? `<span class="estado off">Anulada</span>` : ""}</h3><button class="btn-icono" data-cerrar>✕</button></div>
    <p class="sub" style="margin:-6px 0 12px">${fechaCorta(v.dia)} ${horaDe(v._t)} · Cajero: ${esc(v.cajero)} · Tasa ${v.tasa ? fmtNum(v.tasa) : "—"}</p>
    ${v.anulada ? `<p class="pos-aviso">Anulada por ${esc(v.anuladaPor || "")}: ${esc(v.motivoAnulacion || "")}</p>` : ""}
    <div class="tabla-wrap"><table>
      <thead><tr><th>Código</th><th>Producto</th><th class="num">Cantidad</th><th class="num">Precio</th><th class="num">Subtotal</th><th class="num">Costo</th></tr></thead>
      <tbody>${v.items.map(i => `<tr><td><span class="codigo">${esc(i.codigo)}</span></td><td>${esc(i.nombre)}</td><td class="num">${fmtCant(i.cantidad, i.unidad)}</td>
        <td class="num">${fmtBs(i.precioBs)}</td><td class="num"><b>${fmtBs(i.subtotalBs ?? i.cantidad * i.precioBs)}</b></td><td class="num sub">${fmtBs(i.costoBs * i.cantidad)}</td></tr>`).join("")}</tbody>
    </table></div>
    <div class="totales-compra">
      <div><small>Total</small><b>${fmtBs(v.totalBs)}</b><span>${v.totalUsd != null ? fmtUsd(v.totalUsd) : ""}</span></div>
      <div><small>Costo</small><b>${fmtBs(v.costoBs)}</b></div>
      <div class="ok"><small>Utilidad</small><b>${fmtBs(v.utilidadBs)}</b></div>
    </div>
    <h4 class="sub-titulo">Pagos</h4>
    <ul class="lista-hist">${(v.pagos || []).map(p => `<li><span><b>${p.codigo}</b> ${p.tipo}${p.ref ? " · Ref. " + esc(p.ref) : ""}</span><b>${p.moneda === "$" ? fmtUsd(p.monto) + " · " : ""}${fmtBs(p.montoBs)}</b></li>`).join("")}</ul>`, 760);
}

function modalAnularVenta(v) {
  abrirModal(`
    <div class="modal-cab"><h3>Anular venta #${numVenta(v.numero)}</h3><button class="btn-icono" data-cerrar>✕</button></div>
    <p style="margin-bottom:12px">Total <b>${fmtBs(v.totalBs)}</b> · ${v.items.length} producto(s). Los productos <b>regresan al inventario</b> y la venta deja de contar en los reportes. Queda registrada como anulada para la auditoría.</p>
    <form id="form-anular">
      <label>Motivo de la anulación<input id="an-motivo" required placeholder="Ej: error del cajero, el cliente devolvió"></label>
      <div class="acciones modal-pie"><span style="flex:1"></span>
        <button type="button" class="btn btn-fantasma" data-cerrar>Cancelar</button>
        <button class="btn btn-peligro">Anular venta</button>
      </div>
    </form>`, 480);
  $("#form-anular").onsubmit = async e => {
    e.preventDefault();
    try {
      await Store.anularVenta(v.id, $("#an-motivo").value.trim(), Estado.usuario.nombre);
      toast(`Venta #${numVenta(v.numero)} anulada`); cerrarModal(); vistaReportes();
    } catch (err) { toast(traducirError(err), true); }
  };
}

function exportarVentas() {
  if (!repDatos) return;
  const filas = [["N° venta", "Fecha", "Hora", "Cajero", "Estado", "Código", "Producto", "Cantidad", "Unidad", "Precio Bs", "Subtotal Bs", "Costo Bs", "Utilidad Bs", "Tasa", "Pagos"]];
  repDatos.ventas.slice().sort((a, b) => a.numero - b.numero).forEach(v => v.items.forEach(i => {
    const sub = i.subtotalBs ?? i.cantidad * i.precioBs;
    filas.push([numVenta(v.numero), fechaCorta(v.dia), horaDe(v._t), v.cajero, v.anulada ? "ANULADA" : "OK", i.codigo, i.nombre,
      i.cantidad, i.unidad, i.precioBs, sub, i.costoBs * i.cantidad, sub - i.costoBs * i.cantidad, v.tasa || 0,
      (v.pagos || []).map(p => `${p.codigo} ${p.tipo} ${p.moneda === "$" ? "$" + p.monto : "Bs " + p.montoBs}`).join(" + ")]);
  }));
  descargarCSV(`ventas_${filtrosRep.desde}_${filtrosRep.hasta}`, filas);
}
function exportarProductos() {
  if (!repDatos) return;
  const r = calcularReporte();
  descargarCSV(`utilidad_productos_${filtrosRep.desde}_${filtrosRep.hasta}`,
    [["Código", "Producto", "Cantidad", "Unidad", "Ventas Bs", "Costo Bs", "Utilidad Bs", "Utilidad $"],
     ...r.productos.map(p => [p.codigo, p.nombre, p.cant, p.unidad, p.ventasBs, p.costoBs, p.utilBs, p.utilUsd])]);
}

/* ---------- Usuarios (solo dueño) ---------- */
async function vistaUsuarios() {
  $("#vista").innerHTML = `<div class="tarjeta"><div class="spinner" style="margin:20px auto"></div></div>`;
  try {
    const lista = await Store.listarUsuarios();
    const pendientes = lista.filter(u => !u.activo).length;
    $("#vista").innerHTML = `
      ${pendientes ? `<div class="tarjeta" style="background:var(--amarillo);border:none;margin-bottom:16px">⏳ Hay <b>${pendientes}</b> usuario(s) esperando activación.</div>` : ""}
      <div class="tarjeta">
        <h3>Usuarios del sistema</h3>
        <p class="nota" style="margin:-6px 0 14px">Los nuevos usuarios se registran desde la pantalla de ingreso; aquí les asignas el rol y los activas.</p>
        <div class="tabla-wrap"><table>
          <thead><tr><th>Nombre</th><th>Correo</th><th>Rol</th><th>Estado</th><th></th></tr></thead>
          <tbody>${lista.map(u => {
            const yo = u.uid === Estado.usuario.uid;
            return `<tr>
              <td><b>${esc(u.nombre)}</b>${yo ? " <small>(tú)</small>" : ""}</td>
              <td>${esc(u.email)}</td>
              <td>${yo ? `<span class="rol-badge dueno">Dueño</span>` : `
                <select data-rol="${u.uid}">
                  <option value="cajero" ${u.rol === "cajero" ? "selected" : ""}>Cajero</option>
                  <option value="dueno" ${u.rol === "dueno" ? "selected" : ""}>Dueño</option>
                </select>`}</td>
              <td><span class="estado ${u.activo ? "on" : "off"}">${u.activo ? "Activo" : "Inactivo"}</span></td>
              <td>${yo ? "" : `<button class="btn btn-sm ${u.activo ? "btn-peligro" : "btn-primario"}" data-act="${u.uid}" data-val="${!u.activo}">${u.activo ? "Desactivar" : "Activar"}</button>`}</td>
            </tr>`;
          }).join("")}</tbody>
        </table></div>
      </div>
      <div class="tarjeta" style="margin-top:16px">
        <h3>¿Qué ve cada rol?</h3>
        <div class="fila-form">
          <div><span class="rol-badge dueno">Dueño</span><p class="nota">Todo el sistema: ventas, inventario, compras, proveedores, autoconsumo, utilidad, usuarios y configuración.</p></div>
          <div><span class="rol-badge">Cajero</span><p class="nota">Solo lo necesario para vender: Punto de Venta, consulta de inventario (sin costos) y su resumen del día.</p></div>
        </div>
      </div>`;

    $$("[data-rol]").forEach(s => s.onchange = async () => {
      try { await Store.actualizarUsuario(s.dataset.rol, { rol: s.value }); toast("Rol actualizado"); }
      catch (e) { toast(traducirError(e), true); }
    });
    $$("[data-act]").forEach(b => b.onclick = async () => {
      try { await Store.actualizarUsuario(b.dataset.act, { activo: b.dataset.val === "true" }); toast("Usuario actualizado"); vistaUsuarios(); }
      catch (e) { toast(traducirError(e), true); }
    });
  } catch (e) {
    $("#vista").innerHTML = `<div class="tarjeta vacio">${traducirError(e)}</div>`;
  }
}

/* ---------- Configuración (solo dueño) ---------- */
async function vistaConfig() {
  const cfg = await Store.leerConfig().catch(() => ({}));
  const hist = await Store.historialTasas().catch(() => []);
  const t = Estado.tasa;

  $("#vista").innerHTML = `
    <div class="grid-tarjetas" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr))">
      <div class="tarjeta">
        <h3>💵 Tasa BCV del día</h3>
        <form id="form-tasa">
          <label>Bolívares por 1 dólar
            <input type="number" id="tasa-input" step="0.0001" min="0.01" required value="${t ? t.valor : ""}" placeholder="Ej: 245.6700">
          </label>
          <button class="btn btn-primario btn-bloque">Guardar tasa de hoy</button>
        </form>
        <p class="nota">Los precios se guardan en dólares (ref.) y el sistema calcula los bolívares con esta tasa.</p>
        <h3 style="margin-top:18px">Convertidor rápido</h3>
        <div class="conversor">
          <label>Dólares<input type="number" id="conv-usd" step="0.01" placeholder="0.00"></label>
          <label>Bolívares<input type="number" id="conv-bs" step="0.01" placeholder="0.00"></label>
        </div>
      </div>

      <div class="tarjeta">
        <h3>📅 Historial de tasas</h3>
        ${hist.length ? `<ul class="lista-hist">${hist.map(h => `<li><span>${fechaCorta(h.fecha)}</span><b>Bs ${Number(h.valor).toFixed(4)}</b></li>`).join("")}</ul>`
                      : `<p class="vacio">Aún no hay tasas registradas.</p>`}
      </div>
    </div>

    <div class="tarjeta">
      <h3>🏪 Datos del abasto</h3>
      <form id="form-datos">
        <div class="fila-form">
          <label>Nombre<input id="cfg-nombre" value="${esc(cfg.nombreAbasto || "Abasto GFL")}"></label>
          <label>RIF<input id="cfg-rif" value="${esc(cfg.rif || "")}" placeholder="J-00000000-0"></label>
          <label>Teléfono<input id="cfg-tel" value="${esc(cfg.telefono || "")}"></label>
          <label>Stock mínimo por defecto<input type="number" id="cfg-stockmin" min="0" value="${cfg.stockMinimo ?? 5}"></label>
          <label>% IVA (productos que gravan)<input type="number" id="cfg-iva" min="0" max="100" step="0.01" value="${cfg.iva ?? 16}"></label>
        </div>
        <label>Categorías (separadas por coma)<input id="cfg-cats" value="${esc(categorias().join(", "))}"></label>
        <label>Dirección<input id="cfg-dir" value="${esc(cfg.direccion || "")}"></label>
        <label>Mensaje al pie de la nota de venta<input id="cfg-pie" value="${esc(cfg.mensajePie || "La Gloria sea para Dios")}"></label>
        <button class="btn btn-primario">Guardar datos</button>
      </form>
    </div>`;

  $("#form-tasa").onsubmit = async e => {
    e.preventDefault();
    const v = parseFloat($("#tasa-input").value);
    if (!(v > 0)) return toast("Escribe una tasa válida", true);
    try { await Store.guardarTasa(v, Estado.usuario.nombre); toast("Tasa del día guardada ✔"); vistaConfig(); }
    catch (err) { toast(traducirError(err), true); }
  };
  const usd = $("#conv-usd"), bs = $("#conv-bs");
  usd.oninput = () => { if (Estado.tasa) bs.value = (usd.value * Estado.tasa.valor).toFixed(2); };
  bs.oninput = () => { if (Estado.tasa) usd.value = (bs.value / Estado.tasa.valor).toFixed(2); };

  $("#form-datos").onsubmit = async e => {
    e.preventDefault();
    try {
      await Store.guardarConfig({
        nombreAbasto: $("#cfg-nombre").value.trim(),
        rif: $("#cfg-rif").value.trim(),
        telefono: $("#cfg-tel").value.trim(),
        direccion: $("#cfg-dir").value.trim(),
        mensajePie: $("#cfg-pie").value.trim(),
        stockMinimo: Number($("#cfg-stockmin").value) || 0,
        iva: Number($("#cfg-iva").value) || 0,
        categorias: $("#cfg-cats").value.split(",").map(c => c.trim()).filter(Boolean)
      });
      Estado.config = await Store.leerConfig();
      toast("Datos guardados ✔");
    } catch (err) { toast(traducirError(err), true); }
  };
}

/* ---------------------------------------------------------
   7) TASA EN LA BARRA SUPERIOR (tiempo real)
   --------------------------------------------------------- */
function pintarTasa(t) {
  Estado.tasa = t;
  const pill = $("#tasa-pill");
  if (!t) {
    $("#tasa-valor").textContent = "Sin tasa";
    $("#tasa-fecha").textContent = "";
    pill.classList.add("vieja");
    return;
  }
  $("#tasa-valor").textContent = "Bs " + Number(t.valor).toFixed(2);
  const vieja = t.fecha !== hoyISO();
  $("#tasa-fecha").textContent = vieja ? "de " + fechaCorta(t.fecha) : "hoy";
  pill.classList.toggle("vieja", vieja);
}

/* ---------------------------------------------------------
   8) PANTALLAS Y FLUJO DE SESIÓN
   --------------------------------------------------------- */
function mostrar(id) {
  ["pantalla-auth", "pantalla-pendiente", "app"].forEach(p => $("#" + p).classList.toggle("oculto", p !== id));
  $("#cargando").classList.add("oculto");
}

let suscripciones = null; // oyentes en tiempo real (se cancelan al cerrar sesión)
let registrando = false; // evita leer el perfil antes de que se termine de crear
async function alCambiarSesion(sesion) {
  if (registrando) return;
  if (!sesion) {
    (suscripciones || []).forEach(f => typeof f === "function" && f());
    suscripciones = null;
    Estado.usuario = null; Estado.productos = []; Estado.proveedores = []; Estado.repintar = null;
    mostrar("pantalla-auth");
    return;
  }

  let perfil = await Store.perfil(sesion.uid).catch(() => null);
  // Justo después del registro el perfil puede tardar un instante en existir
  if (!perfil) { await new Promise(r => setTimeout(r, 1200)); perfil = await Store.perfil(sesion.uid).catch(() => null); }
  if (!perfil) { toast("No se encontró el perfil del usuario", true); await Store.salir(); return; }

  Estado.usuario = perfil;
  if (!perfil.activo) {
    $("#pend-nombre").textContent = perfil.nombre;
    mostrar("pantalla-pendiente");
    return;
  }

  $("#u-nombre").textContent = perfil.nombre;
  $("#u-avatar").textContent = perfil.nombre.trim().charAt(0).toUpperCase();
  const rol = $("#u-rol");
  rol.textContent = perfil.rol === "dueno" ? "Dueño" : "Cajero";
  rol.classList.toggle("dueno", perfil.rol === "dueno");

  Estado.config = await Store.leerConfig().catch(() => ({}));
  if (!suscripciones) {
    // Tasa y productos en tiempo real: cualquier cambio refresca la pantalla abierta
    suscripciones = [
      Store.escucharTasa(t => { pintarTasa(t); refrescarVista(); }),
      Store.escucharProductos(lista => { Estado.productos = lista; refrescarVista(); })
    ];
    if (perfil.rol === "dueno")
      suscripciones.push(Store.escucharProveedores(l => { Estado.proveedores = l; refrescarVista(); }));
  }

  mostrar("app");
  irA("inicio");
}

function refrescarVista() {
  if (!Estado.usuario || $("#app").classList.contains("oculto")) return;
  if (Estado.vista === "inicio") return vistaInicio();
  if (Estado.repintar) Estado.repintar();
}

function cerrarMenuMovil() {
  $("#sidebar").classList.remove("abierto");
  $("#fondo-menu").classList.add("oculto");
}

/* ---------------------------------------------------------
   9) EVENTOS DE LA PANTALLA DE ACCESO
   --------------------------------------------------------- */
function mostrarForm(cual) {
  ["login", "registro", "recuperar"].forEach(f => $("#form-" + f).classList.toggle("oculto", f !== cual));
  $$(".tab").forEach(t => t.classList.toggle("activo", t.dataset.tab === cual));
  $(".tabs").classList.toggle("oculto", cual === "recuperar");
}

async function conBoton(form, fn) {
  const btn = form.querySelector("[type=submit]");
  const txt = btn.textContent;
  btn.disabled = true; btn.textContent = "Procesando…";
  try { await fn(); } catch (e) { toast(traducirError(e), true); }
  finally { btn.disabled = false; btn.textContent = txt; }
}

function iniciarEventos() {
  $$(".tab").forEach(t => t.onclick = () => mostrarForm(t.dataset.tab));
  $("#btn-ir-recuperar").onclick = () => mostrarForm("recuperar");
  $("#btn-volver-login").onclick = () => mostrarForm("login");
  $$(".ver-clave").forEach(b => b.onclick = () => {
    const i = $("#" + b.dataset.target);
    i.type = i.type === "password" ? "text" : "password";
  });

  $("#form-login").onsubmit = e => {
    e.preventDefault();
    conBoton(e.target, () => Store.ingresar($("#login-email").value.trim(), $("#login-clave").value));
  };

  $("#form-registro").onsubmit = e => {
    e.preventDefault();
    const nombre = $("#reg-nombre").value.trim();
    const c1 = $("#reg-clave").value, c2 = $("#reg-clave2").value;
    if (c1 !== c2) return toast("Las claves no coinciden", true);
    conBoton(e.target, async () => {
      registrando = true;
      try {
        const p = await Store.registrar(nombre, $("#reg-email").value.trim(), c1);
        toast(p.rol === "dueno" ? "¡Cuenta de Dueño creada!" : "Cuenta creada. Espera la activación del dueño.");
      } finally {
        registrando = false;
      }
      const uid = MODO_LOCAL ? JSON.parse(localStorage.getItem("abastoGFL_sesion") || "null")?.uid : firebase.auth().currentUser?.uid;
      if (uid) alCambiarSesion({ uid });
    });
  };

  $("#form-recuperar").onsubmit = e => {
    e.preventDefault();
    conBoton(e.target, async () => {
      await Store.recuperar($("#rec-email").value.trim());
      toast("Enlace enviado. Revisa tu correo (y la carpeta de spam).");
      mostrarForm("login");
    });
  };

  $("#btn-pend-refrescar").onclick = async () => {
    const p = await Store.perfil(Estado.usuario.uid).catch(() => null);
    if (p?.activo) alCambiarSesion({ uid: p.uid }); else toast("Tu cuenta aún no ha sido activada");
  };
  $("#btn-pend-salir").onclick = () => Store.salir();
  $("#btn-salir").onclick = () => { if (confirm("¿Cerrar sesión?")) Store.salir(); };

  $("#btn-menu").onclick = () => {
    $("#sidebar").classList.add("abierto");
    $("#fondo-menu").classList.remove("oculto");
  };
  $("#fondo-menu").onclick = cerrarMenuMovil;
  $("#tasa-pill").onclick = () => { if (esDueno()) irA("config"); };
  $("#modal").onclick = e => { if (e.target.id === "modal") cerrarModal(); };
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#modal").classList.contains("oculto")) cerrarModal(); });
}

/* ---------------------------------------------------------
   10) ARRANQUE
   --------------------------------------------------------- */
document.addEventListener("DOMContentLoaded", () => {
  if (MODO_LOCAL) $("#modo-demo-aviso").classList.remove("oculto");
  iniciarEventos();
  Store.onAuth(alCambiarSesion);

  // App instalable (solo funciona en http/https, no abriendo el archivo directo)
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
});
