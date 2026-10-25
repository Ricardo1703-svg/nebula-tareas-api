'use strict';
(function () {
  var form = document.getElementById('form');
  var lista = document.getElementById('lista');
  var msg = document.getElementById('msg');
  var fEstado = document.getElementById('f-estado');
  var fQ = document.getElementById('f-q');
  var ETIQUETA = { pendiente: 'Pendiente', en_progreso: 'En progreso', completada: 'Completada' };
  var PRIORIDAD = { 1: 'Alta', 2: 'Media', 3: 'Baja' };

  function api(method, url, body) {
    return fetch(url, { method: method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) {
        if (r.status === 204) return null;
        return r.json().then(function (d) {
          if (!r.ok) throw new Error(d.error + (d.detalles ? ': ' + d.detalles.join('; ') : ''));
          return d;
        });
      });
  }
  function aviso(texto, malo) { msg.textContent = texto; msg.className = 'msg' + (malo ? ' malo' : ''); msg.hidden = false; setTimeout(function () { msg.hidden = true; }, 4000); }
  function el(tag, cls, texto) { var e = document.createElement(tag); if (cls) e.className = cls; if (texto != null) e.textContent = texto; return e; }

  function cargar() {
    var qs = new URLSearchParams({ limit: '100' });
    if (fEstado.value) qs.set('estado', fEstado.value);
    if (fQ.value.trim()) qs.set('q', fQ.value.trim());
    api('GET', '/api/tareas?' + qs).then(function (r) {
      lista.textContent = '';
      if (!r.data.length) lista.appendChild(el('li', 'vacio', 'No hay tareas que mostrar.'));
      r.data.forEach(function (t) {
        var li = el('li', 'tarea ' + t.estado);
        var cab = el('div', 'cab');
        cab.appendChild(el('strong', null, '#' + t.id + ' ' + t.titulo));
        cab.appendChild(el('span', 'chip p' + t.prioridad, PRIORIDAD[t.prioridad]));
        cab.appendChild(el('span', 'chip', ETIQUETA[t.estado]));
        if (t.vence_el) cab.appendChild(el('span', 'chip', 'vence ' + t.vence_el));
        li.appendChild(cab);
        if (t.descripcion) li.appendChild(el('p', 'desc', t.descripcion));
        var acc = el('div', 'acciones');
        if (t.estado !== 'completada') {
          var b = el('button', null, 'Completar');
          b.onclick = function () { api('PATCH', '/api/tareas/' + t.id, { estado: 'completada' }).then(cargar).catch(function (e) { aviso(e.message, true); }); };
          acc.appendChild(b);
        }
        var ed = el('button', null, 'Editar'); ed.onclick = function () { editar(t); }; acc.appendChild(ed);
        var del = el('button', 'peligro', 'Eliminar');
        del.onclick = function () {
          if (del.dataset.ok) { api('DELETE', '/api/tareas/' + t.id).then(function () { aviso('Tarea eliminada'); cargar(); }).catch(function (e) { aviso(e.message, true); }); }
          else { del.dataset.ok = '1'; del.textContent = '¿Seguro?'; setTimeout(function () { delete del.dataset.ok; del.textContent = 'Eliminar'; }, 3000); }
        };
        acc.appendChild(del);
        li.appendChild(acc);
        lista.appendChild(li);
      });
    }).catch(function (e) { aviso(e.message, true); });
    api('GET', '/api/estadisticas').then(function (s) {
      document.getElementById('stats').textContent = s.total + ' en total · ' + s.porEstado.pendiente + ' pendientes · ' + s.porEstado.en_progreso + ' en progreso · ' + s.porEstado.completada + ' completadas';
    }).catch(function () {});
  }

  function editar(t) {
    form.id.value = t.id; form.titulo.value = t.titulo; form.descripcion.value = t.descripcion || '';
    form.estado.value = t.estado; form.prioridad.value = String(t.prioridad); form.vence_el.value = t.vence_el || '';
    document.getElementById('titulo-form').textContent = 'Editar tarea #' + t.id;
    document.getElementById('guardar').textContent = 'Guardar cambios';
    document.getElementById('cancelar').hidden = false;
    form.titulo.focus();
  }
  function limpiar() {
    form.reset(); form.id.value = '';
    document.getElementById('titulo-form').textContent = 'Nueva tarea';
    document.getElementById('guardar').textContent = 'Crear tarea';
    document.getElementById('cancelar').hidden = true;
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var body = { titulo: form.titulo.value, descripcion: form.descripcion.value || null, estado: form.estado.value, prioridad: Number(form.prioridad.value), vence_el: form.vence_el.value || null };
    var id = form.id.value;
    api(id ? 'PUT' : 'POST', id ? '/api/tareas/' + id : '/api/tareas', body)
      .then(function () { aviso(id ? 'Tarea actualizada' : 'Tarea creada'); limpiar(); cargar(); })
      .catch(function (e) { aviso(e.message, true); });
  });
  document.getElementById('cancelar').onclick = limpiar;
  fEstado.onchange = cargar;
  var t; fQ.oninput = function () { clearTimeout(t); t = setTimeout(cargar, 300); };
  api('GET', '/api').then(function (i) { document.getElementById('pod').textContent = i.pod; }).catch(function () {});
  cargar();
})();
