// agent/static_admin/app.js — Panel de administración de Claudia
(function(){
  "use strict";
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const fmtN = n => (n ?? 0).toLocaleString("es-MX");
  const fmtMoney = n => "$" + (n ?? 0).toLocaleString("es-MX", {minimumFractionDigits:2, maximumFractionDigits:2});

  function toast(msg, esErr){
    const t = $("toast");
    t.textContent = msg;
    t.classList.toggle("err", !!esErr);
    t.classList.add("vis");
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove("vis"), 3200);
  }

  async function api(path, opts){
    opts = opts || {};
    opts.credentials = "same-origin";
    if(opts.body && !(opts.body instanceof FormData)){
      opts.headers = Object.assign({"Content-Type":"application/json"}, opts.headers || {});
      opts.body = JSON.stringify(opts.body);
    }
    const r = await fetch("/admin" + path, opts);
    if(r.status === 401){ mostrarLogin(); throw new Error("Sesión expirada"); }
    const j = await r.json().catch(() => ({}));
    if(!r.ok || j.ok === false) throw new Error(j.detail || j.error || ("HTTP " + r.status));
    return j;
  }

  // ── Tema ──────────────────────────────────────────────────────────────
  (function(){
    const t = localStorage.getItem("admin-theme") ||
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.setAttribute("data-theme", t);
    $("theme-btn").textContent = t === "dark" ? "☀️" : "🌙";
    $("theme-btn").addEventListener("click", () => {
      const actual = document.documentElement.getAttribute("data-theme");
      const nuevo = actual === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", nuevo);
      localStorage.setItem("admin-theme", nuevo);
      $("theme-btn").textContent = nuevo === "dark" ? "☀️" : "🌙";
    });
  })();

  // ── Autenticación ─────────────────────────────────────────────────────
  let usuarioActual = "";
  function mostrarLogin(){ $("login").classList.remove("oculto"); $("shell").classList.add("oculto"); }
  function mostrarShell(){ $("login").classList.add("oculto"); $("shell").classList.remove("oculto"); cargarSeccion(seccionActual); }

  $("btn-login").addEventListener("click", intentarLogin);
  $("in-pass").addEventListener("keydown", e => { if(e.key === "Enter") intentarLogin(); });
  $("in-user").addEventListener("keydown", e => { if(e.key === "Enter") intentarLogin(); });

  async function intentarLogin(){
    const usuario = $("in-user").value.trim();
    const pass = $("in-pass").value;
    $("login-err").textContent = "";
    try{
      const d = await api("/api/login", {method:"POST", body:{usuario, password: pass}});
      usuarioActual = d.usuario || usuario;
      $("in-pass").value = "";
      mostrarShell();
    }catch(e){ $("login-err").textContent = "Usuario o contraseña incorrectos"; }
  }

  $("btn-logout").addEventListener("click", async () => {
    await api("/api/logout", {method:"POST"}).catch(() => {});
    mostrarLogin();
  });

  // ── Navegación ────────────────────────────────────────────────────────
  const TITULOS = {
    resumen: ["Resumen", "Vista general de la actividad de Claudia"],
    config: ["Parámetros del agente", "Datos del negocio y personalidad de Claudia"],
    conocimiento: ["Conocimiento", "Archivos y ligas que Claudia usa para responder mejor"],
    catalogo: ["Catálogo NetSuite", "Artículos y precios sincronizados"],
    vendedores: ["Vendedores", "A quién y cómo Claudia les avisa"],
    indicadores: ["Indicadores", "Mensajes por vendedor y tiempos de respuesta"],
    aprendizaje: ["Centro de Aprendizaje", "Estrategias, KPIs y notas para mejorar a Claudia IA"],
    usuarios: ["Usuarios", "Quién puede entrar al panel de administración"],
  };
  let seccionActual = "resumen";
  const cargadores = { resumen: cargarResumen, config: cargarConfig, conocimiento: cargarConocimiento,
                        catalogo: cargarCatalogo, vendedores: cargarVendedores, indicadores: cargarIndicadores,
                        aprendizaje: cargarAprendizaje, usuarios: cargarUsuarios };

  document.getElementById("nav").addEventListener("click", e => {
    const btn = e.target.closest(".item");
    if(!btn) return;
    document.querySelectorAll("#nav .item").forEach(b => b.classList.toggle("activo", b === btn));
    document.querySelectorAll(".seccion").forEach(s => s.classList.remove("activa"));
    const sec = btn.dataset.sec;
    seccionActual = sec;
    $("sec-" + sec).classList.add("activa");
    $("titulo-sec").textContent = TITULOS[sec][0];
    $("subtitulo-sec").textContent = TITULOS[sec][1];
    cargarSeccion(sec);
  });

  function cargarSeccion(sec){ (cargadores[sec] || function(){})(); }

  function cargando(el){ el.innerHTML = '<div class="cargando"><div class="spin"></div>Cargando…</div>'; }
  function vacio(el, msg){ el.innerHTML = `<div class="vacio">${esc(msg)}</div>`; }

  // ── Resumen ───────────────────────────────────────────────────────────
  async function cargarResumen(){
    const el = $("sec-resumen");
    cargando(el);
    try{
      const d = await api("/api/metricas");
      const max = Math.max(1, ...d.serie_diaria.map(x => x.mensajes));
      const barras = d.serie_diaria.map(x =>
        `<div class="barra-d" style="height:${Math.max(4, (x.mensajes/max)*64)}px" title="${esc(x.dia)}: ${x.mensajes} mensajes, ${x.clientes} clientes"></div>`
      ).join("");
      el.innerHTML = `
        <div class="grid-kpi">
          <div class="kpi" style="--tono:var(--accent)"><div class="lbl">Clientes contactados</div><div class="val">${fmtN(d.clientes_unicos)}</div><div class="ctx">números únicos que le han escrito</div></div>
          <div class="kpi" style="--tono:var(--green)"><div class="lbl">Mensajes recibidos</div><div class="val">${fmtN(d.mensajes_totales)}</div><div class="ctx">de clientes, total histórico</div></div>
          <div class="kpi" style="--tono:var(--ambar)"><div class="lbl">Leads nuevos</div><div class="val">${fmtN(d.leads_nuevos)}</div><div class="ctx">oportunidades generadas en NetSuite</div></div>
          <div class="kpi" style="--tono:var(--verde)"><div class="lbl">Clientes de cartera atendidos</div><div class="val">${fmtN(d.clientes_existentes_atendidos)}</div><div class="ctx">canalizados a su vendedor</div></div>
          <div class="kpi" style="--tono:var(--brand)"><div class="lbl">Citas agendadas</div><div class="val">${fmtN(d.citas_agendadas)}</div></div>
          <div class="kpi" style="--tono:var(--rojo)"><div class="lbl">Tickets de soporte</div><div class="val">${fmtN(d.tickets_soporte)}</div></div>
          <div class="kpi" style="--tono:var(--accent)"><div class="lbl">Tiempo de respuesta</div><div class="val">${d.tiempo_respuesta_promedio_seg != null ? d.tiempo_respuesta_promedio_seg.toFixed(1)+'s' : '—'}</div><div class="ctx">promedio Claudia → cliente</div></div>
        </div>
        <div class="tarjeta">
          <h3>Actividad de los últimos 14 días</h3>
          ${d.serie_diaria.length ? `<div class="mini-chart">${barras}</div>` : '<div class="vacio">Todavía no hay actividad registrada.</div>'}
        </div>`;
    }catch(e){ vacio(el, "No se pudieron cargar las métricas: " + e.message); }
  }

  // ── Configuración del agente ─────────────────────────────────────────
  async function cargarConfig(){
    const el = $("sec-config");
    cargando(el);
    try{
      const d = await api("/api/config");
      el.innerHTML = `
        <div class="grid2">
          <div class="tarjeta">
            <h3>Datos del negocio</h3>
            <label class="campo">Nombre</label><input type="text" id="cf-negocio-nombre" value="${esc(d.negocio.nombre||'')}">
            <label class="campo">Horario de atención</label><input type="text" id="cf-negocio-horario" value="${esc(d.negocio.horario||'')}">
            <label class="campo">Descripción del negocio</label><textarea id="cf-negocio-desc" style="min-height:120px">${esc(d.negocio.descripcion||'')}</textarea>
            <label class="campo">Nombre del agente</label><input type="text" id="cf-agente-nombre" value="${esc(d.agente.nombre||'')}">
            <label class="campo">Tono</label><input type="text" id="cf-agente-tono" value="${esc(d.agente.tono||'')}">
          </div>
          <div class="tarjeta">
            <h3>Mensajes de sistema</h3>
            <label class="campo">Mensaje cuando no entiende</label><textarea id="cf-fallback" style="min-height:70px">${esc(d.fallback_message||'')}</textarea>
            <label class="campo">Mensaje de error técnico</label><textarea id="cf-error" style="min-height:70px">${esc(d.error_message||'')}</textarea>
          </div>
        </div>
        <div class="tarjeta">
          <h3>System prompt completo <span class="pill pill--warn">Avanzado</span></h3>
          <p style="font-size:12px;color:var(--muted);margin-bottom:10px">Aquí vive la personalidad completa de Claudia y sus reglas. Cámbialo con cuidado — un cambio mal hecho puede romper el comportamiento del agente.</p>
          <textarea id="cf-prompt" style="min-height:340px;font-family:Consolas,monospace;font-size:12.5px">${esc(d.system_prompt||'')}</textarea>
        </div>
        <div class="barra"><button class="btn btn--primario" id="cf-guardar">💾 Guardar cambios</button></div>`;
      $("cf-guardar").addEventListener("click", guardarConfig);
    }catch(e){ vacio(el, "No se pudo cargar la configuración: " + e.message); }
  }

  async function guardarConfig(){
    const btn = $("cf-guardar");
    btn.disabled = true; btn.textContent = "Guardando…";
    try{
      await api("/api/config", {method:"POST", body:{
        negocio: { nombre: $("cf-negocio-nombre").value, horario: $("cf-negocio-horario").value, descripcion: $("cf-negocio-desc").value },
        agente: { nombre: $("cf-agente-nombre").value, tono: $("cf-agente-tono").value },
        fallback_message: $("cf-fallback").value,
        error_message: $("cf-error").value,
        system_prompt: $("cf-prompt").value,
      }});
      toast("Configuración guardada — se aplica en el próximo mensaje");
    }catch(e){ toast("No se pudo guardar: " + e.message, true); }
    btn.disabled = false; btn.textContent = "💾 Guardar cambios";
  }

  // ── Conocimiento ──────────────────────────────────────────────────────
  async function cargarConocimiento(){
    const el = $("sec-conocimiento");
    cargando(el);
    try{
      const d = await api("/api/knowledge");
      const filas = d.archivos.length ? d.archivos.map(a => `
        <div class="kfila">
          <div class="n">${esc(a.nombre)}<small>${(a.tamano/1024).toFixed(1)} KB · actualizado ${esc(a.actualizado.slice(0,16).replace('T',' '))}</small></div>
          <button class="btn btn--peligro btn--sm" data-borrar="${esc(a.nombre)}">Eliminar</button>
        </div>`).join("") : '<div class="vacio">Aún no hay archivos ni ligas cargadas.</div>';

      el.innerHTML = `
        <div class="grid2">
          <div class="tarjeta">
            <h3>Agregar archivo</h3>
            <div class="file-drop" id="drop-zone">📄 Arrastra un archivo aquí o haz clic para elegirlo<br><small>PDF, TXT, CSV, MD — máx. 10 MB</small></div>
            <input type="file" id="in-file" style="display:none">
          </div>
          <div class="tarjeta">
            <h3>Agregar liga</h3>
            <label class="campo">URL</label>
            <input type="url" id="in-link" placeholder="https://...">
            <div class="barra" style="margin-top:12px"><button class="btn btn--primario" id="btn-add-link">🔗 Descargar y agregar</button></div>
          </div>
        </div>
        <div class="tarjeta"><h3>Archivos y ligas cargadas (${d.archivos.length})</h3>${filas}</div>`;

      const dz = $("drop-zone"), inFile = $("in-file");
      dz.addEventListener("click", () => inFile.click());
      dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("hover"); });
      dz.addEventListener("dragleave", () => dz.classList.remove("hover"));
      dz.addEventListener("drop", e => { e.preventDefault(); dz.classList.remove("hover"); if(e.dataTransfer.files[0]) subirArchivo(e.dataTransfer.files[0]); });
      inFile.addEventListener("change", () => { if(inFile.files[0]) subirArchivo(inFile.files[0]); });

      $("btn-add-link").addEventListener("click", async () => {
        const url = $("in-link").value.trim();
        if(!url) return;
        const btn = $("btn-add-link");
        btn.disabled = true; btn.textContent = "Descargando…";
        try{ await api("/api/knowledge/link", {method:"POST", body:{url}}); toast("Liga agregada"); cargarConocimiento(); }
        catch(e){ toast("No se pudo agregar: " + e.message, true); }
        btn.disabled = false; btn.textContent = "🔗 Descargar y agregar";
      });

      el.querySelectorAll("[data-borrar]").forEach(b => b.addEventListener("click", async () => {
        if(!confirm(`¿Eliminar "${b.dataset.borrar}"?`)) return;
        try{ await api("/api/knowledge/" + encodeURIComponent(b.dataset.borrar), {method:"DELETE"}); toast("Eliminado"); cargarConocimiento(); }
        catch(e){ toast("No se pudo eliminar: " + e.message, true); }
      }));
    }catch(e){ vacio(el, "No se pudo cargar el conocimiento: " + e.message); }
  }

  async function subirArchivo(archivo){
    const fd = new FormData();
    fd.append("archivo", archivo);
    try{ await api("/api/knowledge/upload", {method:"POST", body:fd}); toast("Archivo subido"); cargarConocimiento(); }
    catch(e){ toast("No se pudo subir: " + e.message, true); }
  }

  // ── Catálogo NetSuite (Artículos + Clientes) ────────────────────────────
  let catPagina = 1, catBuscar = "";
  let cliPagina = 1, cliBuscar = "";
  const ART_COLS = 11, CLI_COLS = 3;

  async function cargarCatalogo(){
    const el = $("sec-catalogo");
    if(!el.dataset.armado){
      el.innerHTML = `
        <div class="tarjeta">
          <h3>Sincronización <span id="cat-estado"></span></h3>
          <div class="barra">
            <button class="btn btn--primario" id="btn-sync">🔄 Sincronizar ahora</button>
            <span id="sync-msg" style="font-size:12px;color:var(--muted)"></span>
          </div>
        </div>
        <div class="barra">
          <button class="btn btn--primario btn--sm" id="tab-articulos" data-tab="articulos">📦 Artículos</button>
          <button class="btn btn--secundario btn--sm" id="tab-clientes" data-tab="clientes">🧑‍💼 Clientes</button>
        </div>
        <div class="tarjeta" id="cat-panel-articulos">
          <h3>Artículos <span id="cat-total" class="pill pill--info"></span></h3>
          <div class="barra"><input type="text" id="cat-buscar" placeholder="Buscar por nombre o código…" style="max-width:340px"></div>
          <div class="tabla-wrap"><table id="cat-tabla"><thead><tr>
            <th>Código</th><th>Nombre</th><th>Tipo</th><th>Grupo</th><th>Línea</th><th>Existencia</th>
            <th>Esc.1</th><th>Esc.2</th><th>Esc.3</th><th>Esc.4</th><th>Esc.5</th></tr></thead>
            <tbody id="cat-tbody"></tbody></table></div>
          <div class="barra" style="margin-top:12px">
            <button class="btn btn--secundario btn--sm" id="cat-prev">← Anterior</button>
            <span id="cat-pag-info" style="font-size:12px;color:var(--muted)"></span>
            <button class="btn btn--secundario btn--sm" id="cat-next">Siguiente →</button>
          </div>
        </div>
        <div class="tarjeta" id="cat-panel-clientes" style="display:none">
          <h3>Clientes <span id="cli-total" class="pill pill--info"></span></h3>
          <div class="barra"><input type="text" id="cli-buscar" placeholder="Buscar por nombre, RFC o vendedor…" style="max-width:340px"></div>
          <div class="tabla-wrap"><table id="cli-tabla"><thead><tr>
            <th>Nombre / Razón social</th><th>RFC</th><th>Vendedor asignado</th></tr></thead>
            <tbody id="cli-tbody"></tbody></table></div>
          <div class="barra" style="margin-top:12px">
            <button class="btn btn--secundario btn--sm" id="cli-prev">← Anterior</button>
            <span id="cli-pag-info" style="font-size:12px;color:var(--muted)"></span>
            <button class="btn btn--secundario btn--sm" id="cli-next">Siguiente →</button>
          </div>
        </div>`;
      el.dataset.armado = "1";
      $("btn-sync").addEventListener("click", sincronizarAhora);

      let deb; $("cat-buscar").addEventListener("input", e => {
        clearTimeout(deb); deb = setTimeout(() => { catBuscar = e.target.value; catPagina = 1; cargarTablaCatalogo(); }, 300);
      });
      $("cat-prev").addEventListener("click", () => { if(catPagina>1){ catPagina--; cargarTablaCatalogo(); } });
      $("cat-next").addEventListener("click", () => { catPagina++; cargarTablaCatalogo(); });

      let debCli; $("cli-buscar").addEventListener("input", e => {
        clearTimeout(debCli); debCli = setTimeout(() => { cliBuscar = e.target.value; cliPagina = 1; cargarTablaClientes(); }, 300);
      });
      $("cli-prev").addEventListener("click", () => { if(cliPagina>1){ cliPagina--; cargarTablaClientes(); } });
      $("cli-next").addEventListener("click", () => { cliPagina++; cargarTablaClientes(); });

      [$("tab-articulos"), $("tab-clientes")].forEach(btn => btn.addEventListener("click", () => {
        const tab = btn.dataset.tab;
        $("tab-articulos").classList.toggle("btn--primario", tab === "articulos");
        $("tab-articulos").classList.toggle("btn--secundario", tab !== "articulos");
        $("tab-clientes").classList.toggle("btn--primario", tab === "clientes");
        $("tab-clientes").classList.toggle("btn--secundario", tab !== "clientes");
        $("cat-panel-articulos").style.display = tab === "articulos" ? "" : "none";
        $("cat-panel-clientes").style.display = tab === "clientes" ? "" : "none";
        if(tab === "clientes" && !$("cat-panel-clientes").dataset.cargado){
          $("cat-panel-clientes").dataset.cargado = "1";
          cargarTablaClientes();
        }
      }));
    }
    cargarEstadoSync();
    cargarTablaCatalogo();
  }

  async function cargarEstadoSync(){
    try{
      const d = await api("/api/sync/estado");
      const fmt = iso => iso ? new Date(iso).toLocaleString("es-MX", {dateStyle:"medium", timeStyle:"short"}) : "nunca";
      $("cat-estado").innerHTML = `<span class="pill pill--info">${fmtN(d.n_articulos)} artículos</span> <span class="pill pill--info">${fmtN(d.n_clientes)} clientes</span>`;
      $("sync-msg").textContent = `Última sincronización: artículos ${fmt(d.articulos_actualizado)} · clientes ${fmt(d.clientes_actualizado)}`;
    }catch(e){ /* silencioso */ }
  }

  async function sincronizarAhora(){
    const btn = $("btn-sync");
    btn.disabled = true; btn.textContent = "Sincronizando… (puede tardar ~30s)";
    $("sync-msg").textContent = "";
    try{
      const d = await api("/api/sync", {method:"POST"});
      toast(d.ok ? "Sincronización completada" : "Sincronización terminó con errores — revisa el detalle", !d.ok);
      cargarEstadoSync(); cargarTablaCatalogo();
      if($("cat-panel-clientes").dataset.cargado) cargarTablaClientes();
    }catch(e){ toast("Falló la sincronización: " + e.message, true); }
    btn.disabled = false; btn.textContent = "🔄 Sincronizar ahora";
  }

  function fmtEsc(v){ return v != null ? fmtMoney(v) : '—'; }

  async function cargarTablaCatalogo(){
    const tbody = $("cat-tbody");
    tbody.innerHTML = `<tr><td colspan="${ART_COLS}" class="cargando"><div class="spin"></div></td></tr>`;
    try{
      const d = await api(`/api/catalogo?buscar=${encodeURIComponent(catBuscar)}&pagina=${catPagina}&tam=25`);
      $("cat-total").textContent = fmtN(d.total) + " en catálogo";
      if(!d.articulos.length){ tbody.innerHTML = `<tr><td colspan="${ART_COLS}" class="vacio">Sin resultados.</td></tr>`; }
      else tbody.innerHTML = d.articulos.map(a => `<tr>
          <td>${esc(a.codigo)}</td><td class="ellipsis" title="${esc(a.nombre)}">${esc(a.nombre)}</td>
          <td>${esc(a.tipo||'—')}</td>
          <td>${esc(a.grupo||'—')}</td>
          <td>${esc(a.linea||'—')}</td>
          <td class="num">${(a.existencia||0).toLocaleString('es-MX')}</td>
          <td class="num">${fmtEsc(a.precio_escala_1)}</td>
          <td class="num">${fmtEsc(a.precio_escala_2)}</td>
          <td class="num">${fmtEsc(a.precio_escala_3)}</td>
          <td class="num">${fmtEsc(a.precio_escala_4)}</td>
          <td class="num">${fmtEsc(a.precio_escala_5)}</td>
        </tr>`).join("");
      const totalPag = Math.max(1, Math.ceil(d.total / d.tam));
      $("cat-pag-info").textContent = `Página ${d.pagina} de ${totalPag}`;
    }catch(e){ tbody.innerHTML = `<tr><td colspan="${ART_COLS}" class="vacio">Error: ${esc(e.message)}</td></tr>`; }
  }

  async function cargarTablaClientes(){
    const tbody = $("cli-tbody");
    tbody.innerHTML = `<tr><td colspan="${CLI_COLS}" class="cargando"><div class="spin"></div></td></tr>`;
    try{
      const d = await api(`/api/clientes?buscar=${encodeURIComponent(cliBuscar)}&pagina=${cliPagina}&tam=25`);
      $("cli-total").textContent = fmtN(d.total) + " en catálogo";
      if(!d.clientes.length){ tbody.innerHTML = `<tr><td colspan="${CLI_COLS}" class="vacio">Sin resultados.</td></tr>`; }
      else tbody.innerHTML = d.clientes.map(c => `<tr>
          <td class="ellipsis" title="${esc(c.nombre)}">${esc(c.nombre)}</td>
          <td>${esc(c.rfc||'—')}</td>
          <td>${esc(c.salesrep_nombre||'—')}</td>
        </tr>`).join("");
      const totalPag = Math.max(1, Math.ceil(d.total / d.tam));
      $("cli-pag-info").textContent = `Página ${d.pagina} de ${totalPag}`;
    }catch(e){ tbody.innerHTML = `<tr><td colspan="${CLI_COLS}" class="vacio">Error: ${esc(e.message)}</td></tr>`; }
  }

  // ── Vendedores ────────────────────────────────────────────────────────
  async function cargarVendedores(){
    const el = $("sec-vendedores");
    cargando(el);
    try{
      const d = await api("/api/vendedores");
      const filas = d.vendedores.map(v => `
        <tr data-id="${esc(v.netsuite_id)}">
          <td>${esc(v.nombre)}</td>
          <td><input type="text" class="ed-email" value="${esc(v.email||'')}" style="min-width:170px"></td>
          <td><input type="text" class="ed-whatsapp" value="${esc(v.whatsapp||'')}" placeholder="+52..." style="min-width:150px"></td>
          <td>${v.whatsapp ? '<span class="pill pill--ok">Activo</span>' : '<span class="pill pill--err">Sin WhatsApp</span>'}</td>
          <td><button class="btn btn--secundario btn--sm" data-guardar>Guardar</button>
              <button class="btn btn--peligro btn--sm" data-eliminar>Eliminar</button></td>
        </tr>`).join("");

      el.innerHTML = `
        <div class="tarjeta">
          <h3>Agregar vendedor</h3>
          <div class="grid2">
            <div><label class="campo">Nombre completo</label><input type="text" id="nv-nombre"></div>
            <div><label class="campo">ID de empleado en NetSuite</label><input type="text" id="nv-id"></div>
            <div><label class="campo">Correo</label><input type="email" id="nv-email"></div>
            <div><label class="campo">WhatsApp</label><input type="tel" id="nv-whatsapp" placeholder="+52..."></div>
          </div>
          <div class="barra" style="margin-top:14px"><button class="btn btn--primario" id="nv-guardar">➕ Agregar vendedor</button></div>
        </div>
        <div class="tarjeta">
          <h3>Vendedores (${d.vendedores.length})</h3>
          <div class="tabla-wrap"><table><thead><tr><th>Nombre</th><th>Correo</th><th>WhatsApp</th><th>Estado</th><th></th></tr></thead>
          <tbody>${filas || '<tr><td colspan="5" class="vacio">Sin vendedores.</td></tr>'}</tbody></table></div>
        </div>`;

      $("nv-guardar").addEventListener("click", async () => {
        try{
          await api("/api/vendedores", {method:"POST", body:{
            nombre: $("nv-nombre").value, netsuite_id: $("nv-id").value,
            email: $("nv-email").value, whatsapp: $("nv-whatsapp").value,
          }});
          toast("Vendedor agregado"); cargarVendedores();
        }catch(e){ toast("No se pudo agregar: " + e.message, true); }
      });

      el.querySelectorAll("[data-guardar]").forEach(b => b.addEventListener("click", async e => {
        const tr = e.target.closest("tr");
        try{
          await api("/api/vendedores/" + encodeURIComponent(tr.dataset.id), {method:"PUT", body:{
            email: tr.querySelector(".ed-email").value, whatsapp: tr.querySelector(".ed-whatsapp").value,
          }});
          toast("Guardado"); cargarVendedores();
        }catch(e2){ toast("No se pudo guardar: " + e2.message, true); }
      }));
      el.querySelectorAll("[data-eliminar]").forEach(b => b.addEventListener("click", async e => {
        const tr = e.target.closest("tr");
        if(!confirm("¿Eliminar este vendedor de la lista de WhatsApp?")) return;
        try{ await api("/api/vendedores/" + encodeURIComponent(tr.dataset.id), {method:"DELETE"}); toast("Eliminado"); cargarVendedores(); }
        catch(e2){ toast("No se pudo eliminar: " + e2.message, true); }
      }));
    }catch(e){ vacio(el, "No se pudieron cargar los vendedores: " + e.message); }
  }

  // ── Indicadores ───────────────────────────────────────────────────────
  async function cargarIndicadores(){
    const el = $("sec-indicadores");
    cargando(el);
    try{
      const [d, e2] = await Promise.all([api("/api/indicadores"), api("/api/indicadores/estrategicos")]);
      const filas = d.por_vendedor.map(v => `
        <tr>
          <td>${esc(v.vendedor)}</td>
          <td class="num">${fmtN(v.lead_nuevo)}</td>
          <td class="num">${fmtN(v.cliente_existente)}</td>
          <td class="num">${fmtN(v.total)}</td>
          <td class="num">${v.total ? Math.round((v.entregados/v.total)*100) + '%' : '—'}</td>
        </tr>`).join("");

      const alertasHtml = e2.alertas_notificacion_7d.length ? e2.alertas_notificacion_7d.map(a => {
        // Los clientes que quedaron esperando: son los que hay que marcar a
        // mano, el porcentaje solo, sin ellos, no es accionable.
        const esperando = (a.clientes_esperando || []).map(c => `
          <div class="kfila" style="padding-left:14px">
            <div class="n">${esc(c.telefono)}<small>${esc(c.categoria)} · ${esc((c.creado || "").slice(0,16))}</small></div>
            <span class="pill pill--err">sin avisar</span>
          </div>`).join("");
        return `
        <div class="kfila">
          <div class="n">${esc(a.vendedor)}<small>${a.entregados}/${a.total} entregadas en los últimos 7 días</small></div>
          <span class="pill pill--err">${a.tasa_pct}% entrega</span>
        </div>${esperando}`;
      }).join("") : '<div class="vacio">Sin alertas — todos los vendedores con notificaciones en los últimos 7 días tienen 100% de entrega.</div>';

      const maxMotivo = Math.max(1, ...e2.distribucion_motivos.map(m => m.total));
      const motivosHtml = e2.distribucion_motivos.length ? e2.distribucion_motivos.map(m => `
        <div class="kfila">
          <div class="n" style="flex:0 0 220px">${esc(m.motivo)}</div>
          <div style="flex:1;background:var(--chip);border-radius:6px;overflow:hidden;height:18px">
            <div style="width:${(m.total/maxMotivo)*100}%;height:100%;background:var(--accent)"></div>
          </div>
          <div style="flex:0 0 40px;text-align:right;font-weight:700">${fmtN(m.total)}</div>
        </div>`).join("") : '<div class="vacio">Sin conversaciones registradas todavía.</div>';

      el.innerHTML = `
        <div class="grid-kpi">
          <div class="kpi" style="--tono:var(--accent)"><div class="lbl">Notificaciones enviadas</div><div class="val">${fmtN(d.total_notificaciones)}</div></div>
          <div class="kpi" style="--tono:var(--verde)"><div class="lbl">Tasa de entrega</div><div class="val">${d.tasa_entrega_pct != null ? d.tasa_entrega_pct+'%' : '—'}</div><div class="ctx">confirmada por WhatsApp, no solo aceptada</div></div>
        </div>
        <div class="tarjeta">
          <h3>Mensajes por vendedor</h3>
          <div class="tabla-wrap"><table><thead><tr><th>Vendedor</th><th>Leads nuevos</th><th>Clientes de cartera</th><th>Total</th><th>% Entregado</th></tr></thead>
          <tbody>${filas || '<tr><td colspan="5" class="vacio">Todavía no hay notificaciones registradas.</td></tr>'}</tbody></table></div>
        </div>

        <div class="encabezado" style="margin:26px 0 10px"><div><h2 style="font-size:16px">KPIs estratégicos</h2><div class="sub">Del Centro de Aprendizaje — aprobados por el administrador</div></div></div>

        <div class="grid-kpi">
          <div class="kpi" style="--tono:var(--accent)"><div class="lbl">Conversión conversación → venta</div><div class="val">${e2.tasa_conversion_pct != null ? e2.tasa_conversion_pct+'%' : '—'}</div><div class="ctx">${fmtN(e2.convertidos)} de ${fmtN(e2.clientes_unicos)} clientes únicos generaron un lead o notificación</div></div>
          <div class="kpi" style="--tono:var(--ambar)"><div class="lbl">Abandono de carrito</div><div class="val">${e2.tasa_abandono_carrito_pct != null ? e2.tasa_abandono_carrito_pct+'%' : '—'}</div><div class="ctx">${fmtN(e2.carritos_abandonados)} de ${fmtN(e2.carritos_total)} carritos nunca se confirmaron</div></div>
          <div class="kpi" style="--tono:var(--verde)"><div class="lbl">Re-contacto en 30 días</div><div class="val">${e2.tasa_recontacto_30d_pct != null ? e2.tasa_recontacto_30d_pct+'%' : '—'}</div><div class="ctx">${fmtN(e2.recontactados)} de ${fmtN(e2.clientes_evaluados_recontacto)} clientes volvieron a escribir</div></div>
        </div>

        <div class="tarjeta">
          <h3>Alerta temprana — entregas fallidas en los últimos 7 días <span class="pill ${e2.alertas_notificacion_7d.length ? 'pill--err' : 'pill--ok'}">${e2.alertas_notificacion_7d.length}</span></h3>
          <p style="font-size:12px;color:var(--muted);margin-bottom:10px">A diferencia de la tasa de entrega histórica de arriba, esto solo mira los últimos 7 días — detecta un vendedor con la ventana de WhatsApp cerrada AHORA, no diluido en el promedio.</p>
          ${alertasHtml}
        </div>

        <div class="tarjeta">
          <h3>Distribución de motivos de contacto</h3>
          <p style="font-size:12px;color:var(--muted);margin-bottom:10px">Clasificado por el primer mensaje de cada conversación (cotización/precio, soporte, cita/servicio, o general).</p>
          ${motivosHtml}
        </div>`;
    }catch(e){ vacio(el, "No se pudieron cargar los indicadores: " + e.message); }
  }

  // ── Centro de Aprendizaje ─────────────────────────────────────────────
  const ETIQUETA_CATEGORIA = {
    estrategia_ventas: ["Estrategia de ventas", "pill--info"],
    kpi: ["KPI / indicador", "pill--ok"],
    mejora_prompt: ["Mejora al prompt", "pill--warn"],
    otro: ["Otro", "pill--info"],
  };

  async function cargarAprendizaje(){
    const el = $("sec-aprendizaje");
    cargando(el);
    try{
      const [propR, notasR, docR] = await Promise.all([
        api("/api/aprendizaje/propuestas"), api("/api/aprendizaje/notas"), api("/api/aprendizaje/documento"),
      ]);
      const todas = propR.propuestas;
      const pendientes = todas.filter(p => p.estado === "pendiente");
      const revisadas = todas.filter(p => p.estado !== "pendiente");
      const notas = notasR.notas;
      const notasPendientes = notas.filter(n => n.estado === "pendiente");

      const filaPropuesta = p => {
        const [etiqueta, clasePill] = ETIQUETA_CATEGORIA[p.categoria] || ["Otro", "pill--info"];
        const acciones = p.estado === "pendiente"
          ? `<button class="btn btn--primario btn--sm" data-aprobar="${p.id}">✅ Aprobar y agregar</button>
             <button class="btn btn--peligro btn--sm" data-rechazar="${p.id}">Rechazar</button>`
          : `<span class="pill ${p.estado === 'aprobada' ? 'pill--ok' : 'pill--err'}">${p.estado === 'aprobada' ? 'Aprobada' : 'Rechazada'}</span>`;
        return `
          <div class="kfila" style="align-items:flex-start;flex-direction:column;gap:6px;padding:14px 0">
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;width:100%">
              <span class="pill ${clasePill}">${esc(etiqueta)}</span>
              <span class="pill pill--info" style="opacity:.7">${p.origen === 'analisis_ia' ? '🤖 Análisis IA' : '✍️ Manual'}</span>
              <b style="font-size:13.5px">${esc(p.titulo)}</b>
            </div>
            <div style="font-size:13px;color:var(--txt);white-space:pre-wrap">${esc(p.descripcion)}</div>
            ${p.evidencia ? `<div style="font-size:12px;color:var(--muted)"><b>Evidencia:</b> ${esc(p.evidencia)}</div>` : ""}
            <div class="barra" style="margin-top:4px">${acciones}</div>
          </div>`;
      };

      el.innerHTML = `
        <div class="grid-kpi">
          <div class="kpi" style="--tono:var(--ambar)"><div class="lbl">Propuestas pendientes</div><div class="val">${fmtN(pendientes.length)}</div></div>
          <div class="kpi" style="--tono:var(--verde)"><div class="lbl">Aprobadas</div><div class="val">${fmtN(revisadas.filter(p=>p.estado==='aprobada').length)}</div></div>
          <div class="kpi" style="--tono:var(--accent)"><div class="lbl">Notas para Claude Code</div><div class="val">${fmtN(notasPendientes.length)}</div><div class="ctx">pendientes de revisar</div></div>
        </div>

        <div class="tarjeta">
          <h3>Propuestas pendientes de revisión (${pendientes.length})</h3>
          ${pendientes.length ? pendientes.map(filaPropuesta).join('<hr style="border:none;border-top:1px dashed var(--line)">') : '<div class="vacio">No hay propuestas pendientes. Pídele a Claude Code que corra un análisis nuevo cuando quieras.</div>'}
        </div>

        <div class="tarjeta">
          <h3>Agregar propuesta manual</h3>
          <label class="campo">Título</label><input type="text" id="np-titulo" placeholder="ej. Priorizar marcas con más rotación">
          <label class="campo">Categoría</label>
          <select id="np-categoria">
            <option value="estrategia_ventas">Estrategia de ventas</option>
            <option value="kpi">KPI / indicador</option>
            <option value="mejora_prompt">Mejora al prompt de Claudia</option>
            <option value="otro">Otro</option>
          </select>
          <label class="campo">Descripción</label><textarea id="np-descripcion" style="min-height:90px" placeholder="Qué se propone, de forma concreta"></textarea>
          <label class="campo">Evidencia (opcional)</label><textarea id="np-evidencia" style="min-height:60px" placeholder="Qué dato o conversación la respalda"></textarea>
          <div class="barra" style="margin-top:14px"><button class="btn btn--primario" id="np-guardar">➕ Agregar propuesta</button></div>
        </div>

        <div class="tarjeta">
          <h3>Notas para Claude Code <span class="pill pill--info">${notasPendientes.length} pendientes</span></h3>
          <p style="font-size:12px;color:var(--muted);margin-bottom:10px">No es un chat en vivo — son peticiones o ideas que quedan guardadas aquí para que se revisen y apliquen en la próxima sesión de trabajo real.</p>
          <textarea id="nc-texto" style="min-height:70px" placeholder="ej. Revisar por qué Claudia no ofreció descuento por volumen en cadena..."></textarea>
          <div class="barra" style="margin-top:10px"><button class="btn btn--primario btn--sm" id="nc-guardar">📩 Enviar nota</button></div>
          <div style="margin-top:14px">
            ${notas.length ? notas.map(n => `
              <div class="kfila">
                <div class="n">${esc(n.texto)}<small>${esc(n.creado.slice(0,16).replace('T',' '))} ${n.estado === 'atendida' ? '· ✅ atendida' : ''}</small></div>
                ${n.estado === 'pendiente' ? `<button class="btn btn--secundario btn--sm" data-nota-atendida="${n.id}">Marcar atendida</button>` : ''}
              </div>`).join('') : '<div class="vacio">Sin notas todavía.</div>'}
          </div>
        </div>

        <div class="tarjeta">
          <h3>Propuestas ya revisadas (${revisadas.length}) <span class="pill pill--info" id="ap-toggle-revisadas" style="cursor:pointer">mostrar/ocultar</span></h3>
          <div id="ap-revisadas" style="display:none">
            ${revisadas.length ? revisadas.map(filaPropuesta).join('<hr style="border:none;border-top:1px dashed var(--line)">') : '<div class="vacio">Ninguna todavía.</div>'}
          </div>
        </div>

        <div class="tarjeta">
          <h3>Documento de aprendizaje actual <span class="pill pill--info" id="ap-toggle-doc" style="cursor:pointer">mostrar/ocultar</span></h3>
          <div id="ap-documento" style="display:none">
            <pre style="white-space:pre-wrap;font-size:12px;max-height:480px;overflow-y:auto;background:var(--chip);padding:14px;border-radius:var(--r-sm);line-height:1.6">${esc(docR.contenido || '(vacío)')}</pre>
          </div>
        </div>`;

      $("ap-toggle-revisadas").addEventListener("click", () => {
        const div = $("ap-revisadas"); div.style.display = div.style.display === "none" ? "" : "none";
      });
      $("ap-toggle-doc").addEventListener("click", () => {
        const div = $("ap-documento"); div.style.display = div.style.display === "none" ? "" : "none";
      });

      $("np-guardar").addEventListener("click", async () => {
        try{
          await api("/api/aprendizaje/propuestas", {method:"POST", body:{
            titulo: $("np-titulo").value, categoria: $("np-categoria").value,
            descripcion: $("np-descripcion").value, evidencia: $("np-evidencia").value, origen: "manual",
          }});
          toast("Propuesta agregada"); cargarAprendizaje();
        }catch(e){ toast("No se pudo agregar: " + e.message, true); }
      });

      $("nc-guardar").addEventListener("click", async () => {
        const texto = $("nc-texto").value.trim();
        if(!texto) return;
        try{
          await api("/api/aprendizaje/notas", {method:"POST", body:{texto}});
          toast("Nota enviada"); cargarAprendizaje();
        }catch(e){ toast("No se pudo enviar: " + e.message, true); }
      });

      el.querySelectorAll("[data-aprobar]").forEach(b => b.addEventListener("click", async () => {
        if(!confirm("¿Aprobar esta propuesta? Se agregará automáticamente a APRENDIZAJE_CONOCIMIENTO.md.")) return;
        try{ await api("/api/aprendizaje/propuestas/" + b.dataset.aprobar, {method:"PUT", body:{estado:"aprobada"}}); toast("Propuesta aprobada y agregada al documento"); cargarAprendizaje(); }
        catch(e){ toast("No se pudo aprobar: " + e.message, true); }
      }));
      el.querySelectorAll("[data-rechazar]").forEach(b => b.addEventListener("click", async () => {
        try{ await api("/api/aprendizaje/propuestas/" + b.dataset.rechazar, {method:"PUT", body:{estado:"rechazada"}}); toast("Propuesta rechazada"); cargarAprendizaje(); }
        catch(e){ toast("No se pudo rechazar: " + e.message, true); }
      }));
      el.querySelectorAll("[data-nota-atendida]").forEach(b => b.addEventListener("click", async () => {
        try{ await api("/api/aprendizaje/notas/" + b.dataset.notaAtendida, {method:"PUT", body:{estado:"atendida"}}); toast("Nota marcada como atendida"); cargarAprendizaje(); }
        catch(e){ toast("No se pudo actualizar: " + e.message, true); }
      }));
    }catch(e){ vacio(el, "No se pudo cargar el Centro de Aprendizaje: " + e.message); }
  }

  // ── Usuarios del panel ────────────────────────────────────────────────
  async function cargarUsuarios(){
    const el = $("sec-usuarios");
    cargando(el);
    try{
      const d = await api("/api/usuarios");
      const filas = d.usuarios.map(u => `
        <tr>
          <td>${esc(u.usuario)}${u.usuario === usuarioActual ? ' <span class="pill pill--info">Tú</span>' : ''}</td>
          <td>${esc((u.creado||'').slice(0,16).replace('T',' '))}</td>
          <td>
            <button class="btn btn--secundario btn--sm" data-cambiar="${esc(u.usuario)}">${u.usuario === usuarioActual ? 'Cambiar mi contraseña' : 'Restablecer contraseña'}</button>
            ${u.usuario === usuarioActual ? '' : `<button class="btn btn--peligro btn--sm" data-eliminar="${esc(u.usuario)}">Eliminar</button>`}
          </td>
        </tr>`).join("");

      el.innerHTML = `
        <div class="grid2">
          <div class="tarjeta">
            <h3>Agregar usuario</h3>
            <label class="campo">Usuario</label><input type="text" id="nu-usuario" placeholder="ej. ventas">
            <label class="campo">Contraseña</label><input type="password" id="nu-password" placeholder="mínimo 8 caracteres">
            <div class="barra" style="margin-top:14px"><button class="btn btn--primario" id="nu-guardar">➕ Agregar usuario</button></div>
          </div>
          <div class="tarjeta" id="cambio-password">
            <h3>Cambiar mi contraseña</h3>
            <label class="campo">Contraseña actual</label><input type="password" id="cp-actual">
            <label class="campo">Contraseña nueva</label><input type="password" id="cp-nueva" placeholder="mínimo 8 caracteres">
            <div class="barra" style="margin-top:14px"><button class="btn btn--primario" id="cp-guardar">🔑 Cambiar contraseña</button></div>
          </div>
        </div>
        <div class="tarjeta">
          <h3>Usuarios con acceso (${d.usuarios.length})</h3>
          <div class="tabla-wrap"><table><thead><tr><th>Usuario</th><th>Creado</th><th></th></tr></thead>
          <tbody>${filas || '<tr><td colspan="3" class="vacio">Sin usuarios.</td></tr>'}</tbody></table></div>
        </div>`;

      $("nu-guardar").addEventListener("click", async () => {
        const btn = $("nu-guardar");
        try{
          await api("/api/usuarios", {method:"POST", body:{
            usuario: $("nu-usuario").value.trim(), password: $("nu-password").value,
          }});
          toast("Usuario agregado"); cargarUsuarios();
        }catch(e){ toast("No se pudo agregar: " + e.message, true); }
      });

      $("cp-guardar").addEventListener("click", async () => {
        const btn = $("cp-guardar");
        btn.disabled = true;
        try{
          await api("/api/usuarios/" + encodeURIComponent(usuarioActual) + "/password", {method:"PUT", body:{
            password_actual: $("cp-actual").value, password_nueva: $("cp-nueva").value,
          }});
          $("cp-actual").value = ""; $("cp-nueva").value = "";
          toast("Contraseña actualizada");
        }catch(e){ toast("No se pudo cambiar: " + e.message, true); }
        btn.disabled = false;
      });

      el.querySelectorAll("[data-cambiar]").forEach(b => b.addEventListener("click", async () => {
        const usuario = b.dataset.cambiar;
        if(usuario === usuarioActual){
          // Desplazar NO basta: si la tarjeta ya estaba visible en pantalla,
          // el clic no produce ningún cambio y el botón se siente muerto (se
          // reportó como "le doy y no pasa nada"). Enfocar el primer campo da
          // una señal visible pase lo que pase con el scroll.
          $("cambio-password").scrollIntoView({behavior:"smooth", block:"center"});
          $("cp-actual").focus();
          return;
        }
        const nueva = prompt(`Nueva contraseña para "${usuario}" (mínimo 8 caracteres):`);
        if(!nueva) return;
        try{
          await api("/api/usuarios/" + encodeURIComponent(usuario) + "/password", {method:"PUT", body:{password_nueva: nueva}});
          toast("Contraseña restablecida");
        }catch(e){ toast("No se pudo cambiar: " + e.message, true); }
      }));

      el.querySelectorAll("[data-eliminar]").forEach(b => b.addEventListener("click", async () => {
        if(!confirm(`¿Eliminar el usuario "${b.dataset.eliminar}"? Ya no podrá entrar al panel.`)) return;
        try{ await api("/api/usuarios/" + encodeURIComponent(b.dataset.eliminar), {method:"DELETE"}); toast("Usuario eliminado"); cargarUsuarios(); }
        catch(e){ toast("No se pudo eliminar: " + e.message, true); }
      }));
    }catch(e){ vacio(el, "No se pudieron cargar los usuarios: " + e.message); }
  }

  // ── Arranque ──────────────────────────────────────────────────────────
  (async function(){
    try{
      const r = await fetch("/admin/api/whoami", {credentials:"same-origin"});
      const j = await r.json();
      if(j.autenticado){ usuarioActual = j.usuario || ""; mostrarShell(); } else mostrarLogin();
    }catch(e){ mostrarLogin(); }
  })();
})();
