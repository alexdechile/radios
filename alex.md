# alex.md — Radios App (DonAlex Homelab)

## Último Realizado

- **15-10-2026:**
  - En la pantalla del auto (Apple Car Play y Android Auto) ahora el nombre del artista aparece donde antes se veía el nombre de la emisora, y arriba se ve solo el nombre de la canción.
  - El nombre de la emisora sigue disponible, como dato secundario de la canción que está sonando.
  - Mejoramos lo que muestra la pantalla del auto (Apple Car Play y Android Auto): ahora el logo de la emisora llega en el formato y tamaño que el sistema sí acepta, así se ve la carátula en vez de un cuadro en blanco.
  - Las emisoras que no tienen logo propio ya no aparecen vacías: se muestra el ícono de la aplicación.
  - El texto secundario que aparece bajo el nombre de la canción ahora dice "En vivo" en lugar de "Radios App".
- **29-09-2026:**
  - Mejoramos la búsqueda de portadas y nombres de canciones para que muestre el álbum correcto y no se confunda con versiones en vivo o covers.
  - La aplicación ahora recuerda y vuelve a sintonizar la última radio escuchada al abrirla.
  - El panel de administración ahora actualiza solo los datos modificados sin borrar apodos ni notas.
- **21-09-2026:**
  - Agregamos botón de micrófono en la barra superior para cambiar radios con comandos de voz ("pon radio...", "pausa").
  - La ficha con la información de la canción ahora se abre sola al detectar un tema y se cierra tras 1 minuto.
- **09-09-2026:**
  - Conectamos las radios con el asistente inteligente (Gemini) para poder pedirle recomendaciones y letras de canciones desde el homelab.
  - Corregimos el acceso desde teléfonos Android para que la aplicación abra sin dar error de red.
- **03-09-2026:**
  - Control de volumen táctil muy fino y discreto que se amplía suavemente al tocarlo.
  - Panel de administración para reordenar, destacar y agregar radios favoritas al catálogo.
  - Botón para guardar canciones que te gusten en un historial personal de favoritos.
  - Limpiamos los títulos de canciones para que no muestren textos raros o avisos de la emisora.
- **30-08-2026:** Habilitamos acceso público seguro para poder escuchar las radios desde fuera de la casa.
- **18-08-2026:** Modo especial para iPhone y iPad para que la música no se corte al bloquear la pantalla o cambiar de aplicación.
- **02-08-2026:** Filtro de noticias para que el noticiero no repita los mismos titulares durante el día.
- **28-07-2026:** Noticiero automático cada media hora con la voz de Catalina leyendo titulares de actualidad.
- **26-07-2026:** Mejoramos la instalación en teléfonos como aplicación (PWA) e íconos para pantalla de inicio.
- **25-07-2026:** Opción de leer la letra de las canciones mientras suenan y zoom con dos dedos en pantalla para agrandar o achicar la interfaz.
- **21-07-2026:** Botones rápidos de búsqueda por estilo (vintage, 80s, relax) y tarjeta en pantalla que avisa qué canción está sonando en vivo.
- **Julio 2026:**
  - Versión compacta para celulares pequeños o antiguos (Radios Mini).
  - Temporizador de apagado automático (Sleep Timer) para dormir escuchando música.
  - Alarma despertador con tu radio favorita.
  - Ecualizador de 5 bandas estilo radio de auto.

## ¿Qué hace esta App?

Es el reproductor de radios por internet para el homelab de Alex. Permite sintonizar emisoras chilenas e internacionales con una interfaz retro inspirada en Winamp y un diseño tipo cuaderno/sketch.

- **Música en directo:** Sintoniza radios online con indicador de qué canción está sonando, portada del disco y letra.
- **Control por voz:** Botón de micrófono para pedirle que ponga tu radio favorita o pausar con la voz.
- **Noticiero propio:** Cada 30 minutos una locutora virtual (Catalina) lee un resumen de noticias de actualidad.
- **Diseño adaptable:** Funciona en computadores, tablets y celulares antiguos, con opción de agrandar o achicar la pantalla táctilmente.
- **Panel de administración:** Permite ordenar la lista de radios, agregar nuevas emisoras y destacar las preferidas.

## Stack Técnico

- **Frontend:** HTML5, CSS y JavaScript puro (sin frameworks pesados), compatible con navegadores móviles y modo sin conexión (PWA).
- **Backend:** Servidor en Python (`http.server` modular en el puerto 8000) encargado de consultar portadas, letras y transmitir el audio.
- **Base de datos:** SQLite local para radios curadas, favoritos y almacenamiento temporal de portadas y letras.
- **Voz y Noticias:** Síntesis de voz con Edge-TTS (voz chilena Catalina) y lector de noticias desde sitios de prensa nacional.
- **Servidor e Infraestructura:** Corriendo como servicio de usuario (`radios-app.service`) detrás de Nginx y accesible de forma segura vía Tailscale (`donalex.van-solfeggio.ts.net/radios/`).
