'use strict';
(function () {
  var productos = [];
  var productosVista = [];
  var carrito = new Map();
  var alertaTimer;
  var busquedaTimer;
  var moneda = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
  var fechaLocal = function () {
    return new Intl.DateTimeFormat('es-MX', { dateStyle: 'full' }).format(new Date());
  };

  function api(method, url, body) {
    return fetch(url, {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (response) {
      if (response.status === 204) return null;
      return response.json().then(function (data) {
        if (!response.ok) {
          var details = data.detalles ? ': ' + data.detalles.join('; ') : '';
          throw new Error((data.error || 'No se pudo completar la solicitud') + details);
        }
        return data;
      });
    });
  }

  function money(amount) {
    return moneda.format(Number(amount) || 0);
  }

  function fecha(value) {
    if (!value) return '—';
    var text = typeof value === 'string' ? value.slice(0, 10) : new Date(value).toISOString().slice(0, 10);
    var parts = text.split('-');
    return parts.length === 3 ? parts[2] + '/' + parts[1] + '/' + parts[0] : text;
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function notify(text, error) {
    var node = document.getElementById('notificacion');
    node.textContent = text;
    node.className = 'notificacion' + (error ? ' error' : '');
    node.hidden = false;
    clearTimeout(alertaTimer);
    alertaTimer = setTimeout(function () { node.hidden = true; }, 4500);
  }

  function showError(container, message) {
    container.textContent = '';
    container.appendChild(element('p', 'vacio', message));
  }

  function setView(view) {
    document.querySelectorAll('.vista').forEach(function (section) {
      var active = section.id === 'vista-' + view;
      section.classList.toggle('activa', active);
      section.hidden = !active;
    });
    document.querySelectorAll('.nav-enlace').forEach(function (button) {
      button.classList.toggle('activo', button.dataset.vista === view);
    });
    if (view === 'inventario') cargarProductos();
    if (view === 'ventas') {
      cargarProductos();
      cargarVentas();
    }
    if (view === 'vencimientos') cargarVencimientos();
  }

  function cargarDashboard() {
    api('GET', '/api/dashboard').then(function (stats) {
      document.getElementById('stat-productos').textContent = stats.productos;
      document.getElementById('stat-stock-bajo').textContent = stats.stock_bajo;
      document.getElementById('stat-vencer').textContent = stats.por_vencer;
      document.getElementById('stat-ventas-hoy').textContent = money(stats.ventas_hoy);
      document.getElementById('stat-transacciones').textContent = stats.transacciones_hoy + ' transacciones';
    }).catch(function (error) {
      notify(error.message, true);
      document.querySelectorAll('.metrica strong').forEach(function (item) { item.textContent = '—'; });
    });

    api('GET', '/api/alertas/vencimiento?dias=30').then(function (result) {
      var container = document.getElementById('resumen-alertas');
      var expiring = result.data;
      api('GET', '/api/productos?alerta=stock&limit=100').then(function (stockResult) {
        var lowStock = stockResult.data;
        var badge = document.getElementById('badge-vencimientos');
        badge.textContent = String(expiring.length);
        badge.hidden = expiring.length === 0;
        container.textContent = '';
        var rows = [];
        lowStock.slice(0, 3).forEach(function (product) {
          rows.push({ type: 'stock', name: product.nombre, detail: product.stock_disponible + ' disponibles · mínimo ' + product.stock_minimo });
        });
        expiring.slice(0, Math.max(0, 3 - rows.length)).forEach(function (lot) {
          rows.push({
            type: lot.dias_restantes < 0 ? 'vencido' : 'vencimiento',
            name: lot.nombre,
            detail: lot.dias_restantes < 0 ? 'Lote vencido · ' + fecha(lot.vence_el) : 'Vence ' + fecha(lot.vence_el),
          });
        });
        if (!rows.length) {
          container.appendChild(element('p', 'vacio', 'Sin alertas. El inventario está al día.'));
          return;
        }
        rows.forEach(function (item) {
          var row = element('div', 'alerta-fila');
          var identity = element('div', 'alerta-identidad');
          identity.appendChild(element('strong', null, item.name));
          identity.appendChild(element('small', null, item.detail));
          row.appendChild(identity);
          row.appendChild(element('span', 'estado-chip ' + (item.type === 'stock' || item.type === 'vencimiento' ? 'alerta' : item.type), item.type === 'stock' ? 'Stock bajo' : item.type === 'vencido' ? 'Vencido' : 'Por vencer'));
          container.appendChild(row);
        });
      }).catch(function (error) { showError(container, error.message); });
    }).catch(function (error) {
      showError(document.getElementById('resumen-alertas'), error.message);
      notify(error.message, true);
    });

    api('GET', '/api/ventas?limit=5').then(function (result) {
      renderVentas(result.data, document.getElementById('resumen-ventas'));
    }).catch(function (error) {
      showError(document.getElementById('resumen-ventas'), error.message);
    });
  }

  function cargarProductos() {
    var query = new URLSearchParams({ limit: '100' });
    var search = document.getElementById('buscar-producto').value.trim();
    var alert = document.getElementById('filtro-stock').value;
    if (search) query.set('q', search);
    if (alert) query.set('alerta', alert);
    api('GET', '/api/productos?' + query.toString()).then(function (result) {
      productosVista = result.data;
      renderProductos(result.data);
      if (!search && !alert) {
        productos = result.data;
        renderCatalogo();
        renderCarrito();
      } else {
        api('GET', '/api/productos?limit=100').then(function (catalog) {
          productos = catalog.data;
          renderCatalogo();
          renderCarrito();
        }).catch(function (error) { notify(error.message, true); });
      }
    }).catch(function (error) {
      showError(document.getElementById('tabla-productos'), error.message);
      showError(document.getElementById('catalogo-venta'), error.message);
      notify(error.message, true);
    });
  }

  function renderProductos(items) {
    var tbody = document.getElementById('tabla-productos');
    tbody.textContent = '';
    document.getElementById('conteo-productos').textContent = items.length + (items.length === 1 ? ' producto' : ' productos') + ' en esta vista';
    if (!items.length) {
      var empty = element('tr');
      empty.appendChild(element('td', 'vacio', 'No hay productos que coincidan con tu búsqueda.'));
      empty.firstChild.colSpan = 6;
      tbody.appendChild(empty);
      return;
    }
    items.forEach(function (product) {
      var row = element('tr');
      var name = element('td', 'producto-identidad');
      name.appendChild(element('strong', null, product.nombre));
      name.appendChild(element('small', null, product.codigo + (product.laboratorio ? ' · ' + product.laboratorio : '')));
      row.appendChild(name);
      row.appendChild(element('td', null, product.categoria));
      row.appendChild(element('td', null, money(product.precio)));
      var stock = element('td');
      stock.appendChild(element('span', 'stock-chip' + (Number(product.stock_disponible) <= Number(product.stock_minimo) ? ' bajo' : ''), product.stock_disponible + ' disp. / ' + product.stock + ' total'));
      row.appendChild(stock);
      var expiry = product.proximo_vencimiento ? fecha(product.proximo_vencimiento) : '—';
      if (Number(product.stock_vencido) > 0) expiry = product.stock_vencido + ' vencidos';
      row.appendChild(element('td', null, expiry));
      var actions = element('td');
      var actionWrap = element('div', 'acciones-tabla');
      var addLot = element('button', 'boton-mini', '＋ Lote');
      addLot.type = 'button';
      addLot.dataset.action = 'lote';
      addLot.dataset.id = product.id;
      var edit = element('button', 'boton-mini', 'Editar');
      edit.type = 'button';
      edit.dataset.action = 'editar';
      edit.dataset.id = product.id;
      actionWrap.appendChild(addLot);
      actionWrap.appendChild(edit);
      actions.appendChild(actionWrap);
      row.appendChild(actions);
      tbody.appendChild(row);
    });
  }

  function renderCatalogo() {
    var container = document.getElementById('catalogo-venta');
    var query = document.getElementById('buscar-venta').value.trim().toLocaleLowerCase();
    container.textContent = '';
    var available = productos.filter(function (product) {
      return Number(product.stock_disponible) > 0
        && (!query || (product.nombre + ' ' + product.codigo + ' ' + product.categoria).toLocaleLowerCase().indexOf(query) !== -1);
    });
    if (!available.length) {
      container.appendChild(element('p', 'vacio', 'No hay productos disponibles con esa búsqueda.'));
      return;
    }
    available.forEach(function (product) {
      var row = element('div', 'producto-venta');
      var info = element('div');
      info.appendChild(element('strong', null, product.nombre));
      info.appendChild(element('small', null, product.stock_disponible + ' disponibles · ' + money(product.precio)));
      var add = element('button', 'boton-mini', '+');
      add.type = 'button';
      add.setAttribute('aria-label', 'Agregar ' + product.nombre);
      add.onclick = function () { cambiarCantidad(product.id, 1); };
      row.appendChild(info);
      row.appendChild(add);
      container.appendChild(row);
    });
  }

  function cambiarCantidad(productId, amount) {
    var product = productos.find(function (item) { return Number(item.id) === Number(productId); });
    if (!product) return;
    var next = (carrito.get(Number(productId)) || 0) + amount;
    if (next > Number(product.stock_disponible)) {
      notify('No hay suficientes unidades de ' + product.nombre + '.', true);
      return;
    }
    if (next <= 0) carrito.delete(Number(productId));
    else carrito.set(Number(productId), next);
    renderCarrito();
  }

  function renderCarrito() {
    var container = document.getElementById('carrito');
    var count = 0;
    var total = 0;
    container.textContent = '';
    if (!carrito.size) container.appendChild(element('p', 'carrito-vacio', 'Todavía no agregas productos.'));
    carrito.forEach(function (quantity, id) {
      var product = productos.find(function (item) { return Number(item.id) === id; });
      if (!product) return;
      count += quantity;
      total += Math.round(Number(product.precio) * 100) * quantity;
      var row = element('div', 'carrito-item');
      var info = element('div');
      info.appendChild(element('strong', null, product.nombre));
      info.appendChild(element('small', null, money(product.precio) + ' c/u'));
      var control = element('div', 'cantidad-control');
      var minus = element('button', null, '−');
      minus.type = 'button';
      minus.setAttribute('aria-label', 'Quitar una unidad de ' + product.nombre);
      minus.onclick = function () { cambiarCantidad(id, -1); };
      control.appendChild(minus);
      control.appendChild(element('span', null, String(quantity)));
      var plus = element('button', null, '+');
      plus.type = 'button';
      plus.setAttribute('aria-label', 'Agregar una unidad de ' + product.nombre);
      plus.onclick = function () { cambiarCantidad(id, 1); };
      control.appendChild(plus);
      row.appendChild(info);
      row.appendChild(control);
      container.appendChild(row);
    });
    document.getElementById('cantidad-carrito').textContent = String(count);
    document.getElementById('total-venta').textContent = money(total / 100);
    document.getElementById('registrar-venta').disabled = carrito.size === 0;
  }

  function renderVentas(items, container) {
    container.textContent = '';
    if (!items.length) {
      container.appendChild(element('p', 'vacio', 'Aún no hay ventas registradas.'));
      return;
    }
    items.forEach(function (sale) {
      var row = element('div', 'venta-fila');
      var identity = element('div', 'venta-identidad');
      identity.appendChild(element('strong', null, 'Venta #' + sale.id));
      identity.appendChild(element('small', null, fechaHora(sale.creada_en) + ' · ' + sale.productos + (Number(sale.productos) === 1 ? ' producto' : ' productos')));
      row.appendChild(identity);
      row.appendChild(element('span', 'importe', money(sale.total)));
      container.appendChild(row);
    });
  }

  function fechaHora(value) {
    return new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  }

  function cargarVentas() {
    api('GET', '/api/ventas?limit=20').then(function (result) {
      renderVentas(result.data, document.getElementById('historial-ventas'));
    }).catch(function (error) {
      showError(document.getElementById('historial-ventas'), error.message);
      notify(error.message, true);
    });
  }

  function cargarVencimientos() {
    api('GET', '/api/alertas/vencimiento?dias=90').then(function (result) {
      var container = document.getElementById('tabla-vencimientos');
      container.textContent = '';
      if (!result.data.length) {
        container.appendChild(element('p', 'vacio', 'No hay lotes vencidos ni próximos a vencer.'));
        return;
      }
      var table = element('table');
      var head = element('thead');
      var heading = element('tr');
      ['PRODUCTO', 'LOTE', 'CANTIDAD', 'VENCIMIENTO', 'ESTADO'].forEach(function (label) { heading.appendChild(element('th', null, label)); });
      head.appendChild(heading);
      var body = element('tbody');
      result.data.forEach(function (lot) {
        var row = element('tr');
        var name = element('td', 'producto-identidad');
        name.appendChild(element('strong', null, lot.nombre));
        name.appendChild(element('small', null, lot.codigo));
        row.appendChild(name);
        row.appendChild(element('td', null, lot.codigo_lote));
        row.appendChild(element('td', null, lot.cantidad));
        row.appendChild(element('td', null, fecha(lot.vence_el)));
        var state = Number(lot.dias_restantes) < 0 ? 'Vencido' : Number(lot.dias_restantes) === 0 ? 'Vence hoy' : 'En ' + lot.dias_restantes + ' días';
        var stateCell = element('td');
        stateCell.appendChild(element('span', 'estado-chip ' + (Number(lot.dias_restantes) < 0 ? 'vencido' : 'alerta'), state));
        row.appendChild(stateCell);
        body.appendChild(row);
      });
      table.appendChild(head);
      table.appendChild(body);
      container.appendChild(table);
    }).catch(function (error) {
      showError(document.getElementById('tabla-vencimientos'), error.message);
      notify(error.message, true);
    });
  }

  function abrirProducto(product) {
    var form = document.getElementById('form-producto');
    form.reset();
    form.elements.namedItem('id').value = product ? product.id : '';
    form.elements.namedItem('codigo').value = product ? product.codigo : '';
    form.elements.namedItem('nombre').value = product ? product.nombre : '';
    form.elements.namedItem('categoria').value = product ? product.categoria : 'Medicamentos';
    form.elements.namedItem('laboratorio').value = product ? product.laboratorio || '' : '';
    form.elements.namedItem('precio').value = product ? product.precio : '';
    form.elements.namedItem('stock_minimo').value = product ? product.stock_minimo : 5;
    form.elements.namedItem('descripcion').value = product ? product.descripcion || '' : '';
    document.getElementById('titulo-dialogo-producto').textContent = product ? 'Editar producto' : 'Agregar producto';
    form.querySelector('button[type="submit"]').textContent = product ? 'Guardar cambios' : 'Guardar producto';
    document.getElementById('dialogo-producto').showModal();
  }

  function abrirLote(product) {
    var form = document.getElementById('form-lote');
    form.reset();
    form.elements.namedItem('producto_id').value = product.id;
    document.getElementById('nombre-lote').textContent = product.nombre;
    document.getElementById('dialogo-lote').showModal();
  }

  document.querySelectorAll('[data-vista]').forEach(function (button) {
    button.addEventListener('click', function () { setView(button.dataset.vista); });
  });
  document.querySelectorAll('[data-ir]').forEach(function (button) {
    button.addEventListener('click', function () { setView(button.dataset.ir); });
  });
  document.querySelectorAll('[data-cerrar]').forEach(function (button) {
    button.addEventListener('click', function () { document.getElementById(button.dataset.cerrar).close(); });
  });

  document.getElementById('nuevo-producto').addEventListener('click', function () { abrirProducto(null); });
  document.getElementById('buscar-producto').addEventListener('input', function () {
    clearTimeout(busquedaTimer);
    busquedaTimer = setTimeout(cargarProductos, 250);
  });
  document.getElementById('filtro-stock').addEventListener('change', cargarProductos);
  document.getElementById('buscar-venta').addEventListener('input', renderCatalogo);

  document.getElementById('tabla-productos').addEventListener('click', function (event) {
    var button = event.target.closest('button[data-action]');
    if (!button) return;
    var product = productosVista.find(function (item) { return Number(item.id) === Number(button.dataset.id); });
    if (!product) return;
    if (button.dataset.action === 'editar') abrirProducto(product);
    if (button.dataset.action === 'lote') abrirLote(product);
  });

  document.getElementById('form-producto').addEventListener('submit', function (event) {
    event.preventDefault();
    var form = event.currentTarget;
    var id = form.elements.namedItem('id').value;
    var body = {
      codigo: form.elements.namedItem('codigo').value.trim(),
      nombre: form.elements.namedItem('nombre').value.trim(),
      categoria: form.elements.namedItem('categoria').value.trim(),
      laboratorio: form.elements.namedItem('laboratorio').value.trim() || null,
      descripcion: form.elements.namedItem('descripcion').value.trim() || null,
      precio: Number(form.elements.namedItem('precio').value),
      stock_minimo: Number(form.elements.namedItem('stock_minimo').value),
    };
    api(id ? 'PATCH' : 'POST', id ? '/api/productos/' + id : '/api/productos', body).then(function () {
      document.getElementById('dialogo-producto').close();
      notify(id ? 'Producto actualizado.' : 'Producto agregado.');
      cargarProductos();
      cargarDashboard();
    }).catch(function (error) { notify(error.message, true); });
  });

  document.getElementById('form-lote').addEventListener('submit', function (event) {
    event.preventDefault();
    var form = event.currentTarget;
    var id = form.elements.namedItem('producto_id').value;
    var body = {
      codigo_lote: form.elements.namedItem('codigo_lote').value.trim(),
      vence_el: form.elements.namedItem('vence_el').value,
      cantidad: Number(form.elements.namedItem('cantidad').value),
    };
    api('POST', '/api/productos/' + id + '/lotes', body).then(function () {
      document.getElementById('dialogo-lote').close();
      notify('Entrada de inventario registrada.');
      cargarProductos();
      cargarDashboard();
    }).catch(function (error) { notify(error.message, true); });
  });

  document.getElementById('registrar-venta').addEventListener('click', function (event) {
    var button = event.currentTarget;
    var items = Array.from(carrito, function (entry) { return { producto_id: entry[0], cantidad: entry[1] }; });
    button.disabled = true;
    api('POST', '/api/ventas', { items: items }).then(function (sale) {
      carrito.clear();
      renderCarrito();
      notify('Venta #' + sale.id + ' registrada correctamente.');
      cargarProductos();
      cargarVentas();
      cargarDashboard();
    }).catch(function (error) {
      notify(error.message, true);
      button.disabled = carrito.size === 0;
    });
  });

  document.getElementById('plataforma').textContent = fechaLocal();
  api('GET', '/api').then(function (info) {
    document.title = 'Farmacia La Buena';
    document.getElementById('plataforma').textContent = info.plataforma;
  }).catch(function (error) {
    document.getElementById('plataforma').textContent = 'sin conexión';
    notify(error.message, true);
  });

  cargarDashboard();
  cargarProductos();
  renderCarrito();
})();
