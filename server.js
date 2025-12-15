const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- CONFIGURACIÓN ---
const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// !!! PON TU API KEY DE GOOGLE AI STUDIO AQUÍ !!!
const GEMINI_API_KEY = "AIzaSyBz_uHCPxAf_dRIeh56caSlVtdFh--xKE8"; 
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// --- MUNDO Y FÍSICA ---
const BLOCK_SIZE = 40;
let blocks = {}; // Usamos un objeto {'x,y': tipo} para acceso rápido
let players = {};
let buildQueue = []; // Aquí guardamos los bloques que la IA quiere poner

// Función auxiliar para claves del mapa
const k = (x, y) => `${Math.floor(x)},${Math.floor(y)}`;

io.on('connection', (socket) => {
    console.log('Jugador:', socket.id);

    // Spawneamos al jugador en el aire
    players[socket.id] = {
        x: 0, y: -200, 
        vx: 0, vy: 0, // Velocidad
        color: `hsl(${Math.random()*360}, 100%, 50%)`,
        width: 30, height: 30
    };

    // GENERAR PISO INICIAL BAJO EL JUGADOR
    // 5 bloques de ancho justo debajo de donde aparece (y=0)
    for(let i=-2; i<=2; i++){
        blocks[k(i, 0)] = 1; // 1 = Tierra
    }

    // --- COMANDOS IA ---
    socket.on('pedir_estructura', async (promptUser) => {
        const p = players[socket.id];
        console.log(`IA pensando: ${promptUser}...`);
        
        // Avisar al chat que la IA está pensando
        io.emit('chat_global', { user: 'SISTEMA', text: `🤖 Generando "${promptUser}"...` });

        try {
            // EL PROMPT DE INGENIERÍA: Obligamos a Gemini a responder JSON puro
            const prompt = `
            Eres un arquitecto de un juego 2D tipo Terraria.
            Genera una estructura que represente: "${promptUser}".
            Responde ÚNICAMENTE con un objeto JSON con este formato:
            {
                "matrix": [
                    [0, 1, 0],
                    [1, 1, 1]
                ]
            }
            Donde 1 es bloque y 0 es aire. Hazlo con detalles internos (max 50x50).
            No des explicaciones, solo el JSON.
            `;

            const result = await model.generateContent(prompt);
            const response = await result.response;
            const text = response.text().replace(/```json|```/g, '').trim(); // Limpiar formato
            const data = JSON.parse(text);

            // Convertir la matriz de la IA a coordenadas del mundo
            // Lo ponemos un poco a la derecha del jugador
            const startX = Math.floor(p.x / BLOCK_SIZE) + 3;
            const startY = Math.floor(p.y / BLOCK_SIZE) - data.matrix.length; 

            data.matrix.forEach((row, rI) => {
                row.forEach((cell, cI) => {
                    if (cell === 1) {
                        // AGREGAR A LA COLA (No al mapa directo)
                        buildQueue.push({
                            x: startX + cI,
                            y: startY + rI,
                            type: 2 // 2 = Bloque mágico de IA
                        });
                    }
                });
            });

        } catch (error) {
            console.error(error);
            io.emit('chat_global', { user: 'ERROR', text: 'La IA falló. Intenta de nuevo.' });
        }
    });
    
    // INPUT DE MOVIMIENTO Y CONSTRUCCIÓN
    socket.on('input', (keys) => {
        const p = players[socket.id];
        if(!p) return;
        
        // Movimiento (Igual que antes)
        if(keys.left) p.vx = -5;
        else if(keys.right) p.vx = 5;
        else p.vx = 0;

        if(keys.up && Math.abs(p.vy) < 0.1) p.vy = -12;
        
        // --- NUEVA LÓGICA DE CONSTRUCCIÓN ---
        if(keys.click) {
            const bx = Math.floor(keys.mouse.x / BLOCK_SIZE);
            const by = Math.floor(keys.mouse.y / BLOCK_SIZE);
            const keyPos = k(bx, by);

            if (keys.buildType === 0) {
                // Si elige 0, BORRAMOS el bloque (Aire)
                delete blocks[keyPos];
            } else {
                // Si elige otro número, ponemos ese bloque
                blocks[keyPos] = keys.buildType;
            }
        }
    });

    socket.on('disconnect', () => delete players[socket.id]);
});

// --- BUCLE DEL JUEGO (60 FPS) ---
setInterval(() => {
    // 1. PROCESAR COLA DE CONSTRUCCIÓN (Efecto secuencial)
    // Ponemos 2 bloques por tick para que se vea rápido pero animado
    if(buildQueue.length > 0) {
        const block = buildQueue.shift(); // Sacar el primero
        blocks[k(block.x, block.y)] = block.type;
        // Si hay muchos, sacamos otro más
        if(buildQueue.length > 0) {
            const b2 = buildQueue.shift();
            blocks[k(b2.x, b2.y)] = b2.type;
        }
    }

    // ... dentro del setInterval ...

    // 2. FÍSICA AVANZADA (Solid Body)
    for (const id in players) {
        const p = players[id];

        // Aplicar Gravedad
        p.vy += 0.5; 
        // Límite de velocidad terminal (para que no caiga infinito de rápido y atraviese el suelo)
        if(p.vy > 15) p.vy = 15;

        // --- EJE X (Horizontal) ---
        // Intentamos movernos
        let potentialX = p.x + p.vx;
        
        // ¿Chocamos si nos movemos ahí?
        if (playerCollides(potentialX, p.y, p.width, p.height)) {
            // SI CHOCAMOS: No nos movemos.
            // (Aquí podríamos alinear al borde, pero por ahora detenerse basta)
            p.vx = 0; 
        } else {
            // NO CHOCAMOS: Avanzamos
            p.x = potentialX;
        }

        // --- EJE Y (Vertical) ---
        // Intentamos movernos
        let potentialY = p.y + p.vy;

        // ¿Chocamos si nos movemos ahí?
        if (playerCollides(p.x, potentialY, p.width, p.height)) {
            // SI CHOCAMOS:
            if (p.vy > 0) {
                // Estábamos cayendo (tocamos suelo)
                p.vy = 0;
                // Opcional: Alinear perfectamente al suelo para evitar vibración visual
                // p.y = Math.floor(potentialY / BLOCK_SIZE) * BLOCK_SIZE; 
            } else if (p.vy < 0) {
                // Estábamos saltando (tocamos techo)
                p.vy = 0; 
            }
        } else {
            // NO CHOCAMOS: Avanzamos
            p.y = potentialY;
        }

        // Límite de caída al vacío (Respawn)
        if(p.y > 2000) { p.y = -200; p.vy = 0; p.x=0; }
    }
    
    // ... (envio de estado) ...

    // 3. ENVIAR ESTADO
    // Enviamos 'blocks' como array de strings para que pese menos
    io.volatile.emit('state', { 
        players, 
        blocks: blocks 
    });

}, 1000 / 60);

// Función para detectar si un rectángulo choca con algún bloque sólido
function playerCollides(x, y, w, h) {
    // Calculamos los bordes del jugador en coordenadas de cuadrícula
    // Usamos un pequeño margen (padding) de 0.1 para no chocar si estamos JUSTO al lado
    const left = Math.floor(x / BLOCK_SIZE);
    const right = Math.floor((x + w - 0.1) / BLOCK_SIZE);
    const top = Math.floor(y / BLOCK_SIZE);
    const bottom = Math.floor((y + h - 0.1) / BLOCK_SIZE);

    // Revisamos todos los bloques que caen dentro del área del jugador
    for (let bx = left; bx <= right; bx++) {
        for (let by = top; by <= bottom; by++) {
            if (blocks[k(bx, by)]) {
                return true; // ¡Hay un bloque aquí!
            }
        }
    }
    return false; // Área libre
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🌍 Mundo IA corriendo en ${PORT}`));