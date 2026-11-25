# Abasto GFL · Sistema de Control Interno

## Entregas
- **1:** acceso, roles (Dueño/Cajero), tasa BCV y estructura base
- **4:** Proveedores (cuentas por pagar y abonos), Compras (entrada por factura, actualiza costo y stock), Autoconsumo y Mermas (al costo), Utilidad y Reportes (utilidad neta, cuadre por tipo de pago, por producto, por cajero, anulación de ventas, exportar a Excel)
- **3:** Punto de Venta (F10 cobrar, 01–05 tipos de pago, 99 guardar, alerta roja con sonido / señal verde)
- **2:** productos, inventario en tiempo real, ajustes con kárdex y Lista de Precios (IVA, costo en Bs según la tasa, % de ganancia, alertas en rojo)

> Después de cada entrega, vuelve a publicar `firestore.rules` en Firebase.

### Probar ya (modo local)
Abre `index.html` en el navegador. Mientras `script.js` tenga `TU_API_KEY`, todo se guarda solo en ese navegador.
El primer usuario que se registre queda como **Dueño**. Los siguientes quedan como **Cajero** inactivo, hasta que el dueño los active en *Usuarios*.

### Punto de Venta: cómo se usa
1. **Con el lector**, el producto se agrega solo al escanear, sin pulsar Enter. **A mano**, escribe el código y pulsa **Enter**.
   - Si el producto ya estaba en la lista, su cantidad se suma y la línea baja al final, con el subtotal = cantidad × precio unitario.
   - **3*001** agrega 3 unidades del producto 001.
   - Si el producto se vende por kilo, aparece la casilla del **peso**: escríbelo (ej: 0.350) y pulsa Enter.
   - Si escribes parte del nombre, aparecen sugerencias: muévete con ↑ ↓ y elige con Enter.
2. **F10** abre el cobro. Escribe el tipo de pago y pulsa Enter:
   01 DÉBITO · 02 EFECTIVO · 03 DIVISAS ($) · 04 PAGO MÓVIL · 05 TRANSFERENCIA
3. Escribe el monto (ya viene con lo que falta) y pulsa Enter.
4. Puedes repetir el paso 2 para un pago mixto.
5. **99** + Enter guarda la venta:
   - Si el cobro no cuadra con el total, aparece una **alerta roja con sonido**.
   - Si cuadra, aparece la **señal verde** y la pantalla queda lista para el siguiente cliente.
6. **Esc** regresa o cierra el cobro. **F8** anula la venta en curso.
7. **F4 · Poner en espera:** pregunta *¿Desea colocar la venta en espera?* y pide el nombre del cliente. **F6 · Ventas en espera:** muestra la lista con nombre y monto; el botón **Cargar** devuelve los productos a la pantalla para cobrarlos. Las ventas en espera se guardan en ese equipo (la caja).

### Conectar a Firebase (proyecto nuevo)
1. Entra a https://console.firebase.google.com y crea el proyecto **abasto-gfl** (Analytics no es necesario).
2. **Authentication → Comenzar → Correo electrónico/contraseña → Habilitar.**
3. **Firestore Database → Crear base de datos →** modo producción, ubicación `nam5` o `us-east1`.
4. **Firestore → Reglas:** pega el contenido de `firestore.rules` y pulsa **Publicar**.
5. **Configuración del proyecto (⚙️) → Tus apps → Web `</>`** → registra la app y copia el objeto `firebaseConfig`.
6. Pega esos datos en `script.js` (sección 1), sustituyendo los `TU_...`.
7. **Authentication → Configuración → Dominios autorizados:** agrega `TU_USUARIO.github.io` cuando lo publiques.
8. Regístrate primero con la cuenta del **dueño**: quedará como dueño fundador.

### Publicar como app en el teléfono
Sube la carpeta a un repositorio de GitHub y activa **GitHub Pages**. Desde el teléfono, abre el enlace en Chrome y entra en **⋮ → Agregar a pantalla principal / Instalar app**.

### Estructura de datos (Firestore)
- `usuarios/{uid}` → nombre, email, rol (`dueno` | `cajero`), activo
- `config/sistema` → ownerUid, nombreAbasto, rif, telefono, direccion, mensajePie, stockMinimo
- `config/tasa` → valor, fecha, por (tasa vigente, se escucha en tiempo real)
- `tasas/{AAAA-MM-DD}` → historial de tasas BCV
- `productos/{id}` → codigo, nombre, categoria, unidad (`und` | `kg`), iva (bool), costoUsd (sin IVA), precioBs, stock, stockMin, activo
- `movimientos/{id}` → productoId, tipo (inicial, ajuste, venta, compra, autoconsumo, merma), cantidad, antes, despues, motivo, usuario, fecha

### Cálculo de la Lista de Precios
- Costo real $ = costo $ × 1,16 (solo si el producto grava IVA)
- Costo Bs = costo real $ × tasa BCV del día
- % ganancia = (precio Bs − costo Bs) ÷ costo Bs × 100
- Rojo: ganancia negativa · Amarillo: ganancia entre 0 % y 10 %
- `ventas/{id}` → numero (correlativo), dia, cajero, tasa, items[], totalBs, totalUsd, costoBs, utilidadBs, pagos[{codigo, tipo, moneda, monto, montoBs, ref}]
- `config/contadores` → ventas (último correlativo)
- `proveedores/{id}` → nombre, rif, telefono, contacto, dias, direccion, notas, activo
- `compras/{id}` → proveedorId, factura, dia, condicion (contado|credito), moneda (USD|BS), tasa, items[], subtotalUsd, ivaUsd, totalUsd, totalBs, saldoUsd, abonos[]
- `salidas/{id}` → dia, tipo (autoconsumo|merma|vencido), producto, cantidad, costoUsd, costoBs, nota

### Utilidad neta
Ventas − costo de lo vendido (costo con IVA × tasa del momento de la venta) − autoconsumo − mermas y vencidos (al costo).
Las compras **no** se restan de la utilidad: entran al inventario y se convierten en costo cuando se venden.
