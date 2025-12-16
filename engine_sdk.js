(function(global) {
    
    const EngineSDK = {
        config: { serverUrl: 'http://localhost:3000' },
        socket: null,
        currentRoom: null,
        
        // ESTADO LOCAL (La verdad del cliente)
        localState: {
            players: {},
            global: {}
        },

        init: function(options) {
            if (options.serverUrl) this.config.serverUrl = options.serverUrl;
        },

        conectar: function(roomId, callbacks = {}) {
            if (typeof io === 'undefined') return console.error("Falta Socket.IO");
            if (this.socket) this.socket.disconnect();
            
            this.socket = io(this.config.serverUrl);
            this.currentRoom = roomId;

            this.socket.on('connect', () => {
                this.socket.emit('join_room', roomId);
                if (callbacks.onConnect) callbacks.onConnect(this.socket.id);
                // Iniciar bucle visual local
                this._startRenderLoop();
            });

            // 1. CARGA INICIAL
            this.socket.on('init_state', (serverState) => {
                // Fusión profunda simple
                this.localState = { ...this.localState, ...serverState };
                if(!this.localState.players) this.localState.players = {};
            });

            // 2. RECEPCIÓN DE EVENTOS (RELAY)
            this.socket.on('relay_event', (packet) => {
                this._processPacket(packet);
            });

            this.socket.on('notification', (msg) => {
                if (window.alert && msg.includes('Error')) window.alert(msg);
                console.log('[SERVER]:', msg);
            });
        },

        /**
         * PROCESAMIENTO INTERNO DE PAQUETES
         */
        _processPacket: function(packet) {
            const { senderId, action, targetId, ...data } = packet;

            // A. FILTRO DE PRIVACIDAD
            // Si el mensaje tiene un destinatario y NO soy yo, lo ignoro.
            if (targetId && targetId !== this.socket.id) {
                return; 
            }

            // B. GESTIÓN DE DESCONEXIÓN
            if (action === 'DISCONNECT') {
                delete this.localState.players[senderId];
                return;
            }

            // C. ACTUALIZACIÓN DE ESTADO
            // Si no existe el jugador, se crea
            if (!this.localState.players[senderId]) {
                this.localState.players[senderId] = {};
            }

            // Mezclamos los datos nuevos con los que ya teníamos
            const player = this.localState.players[senderId];
            Object.assign(player, data);
            
            // Metadatos útiles para el renderizador
            player.id = senderId;
            player.lastAction = action; 
        },

        // --- BUCLE DE RENDERIZADO LOCAL (60 FPS) ---
        _renderLoopId: null,
        _startRenderLoop: function() {
            if (this._renderLoopId) cancelAnimationFrame(this._renderLoopId);
            
            const loop = () => {
                if (this._onTickCallback) {
                    // Le pasamos el estado local al usuario para que dibuje
                    this._onTickCallback(this.localState);
                }
                this._renderLoopId = requestAnimationFrame(loop);
            };
            this._renderLoopId = requestAnimationFrame(loop);
        },

        // --- API PÚBLICA ---

        onTick: function(callback) {
            this._onTickCallback = callback;
        },

        /**
         * Envía datos a la sala.
         * @param {string} actionName - Nombre del evento ('MOVE', 'DRAW', etc)
         * @param {object} payload - Datos (x, y, color). 
         * @param {string} targetId - (Opcional) ID de socket privado.
         */
        sendAction: function(actionName, payload = {}, targetId = null) {
            if (!this.socket) return;
            
            const packet = { 
                action: actionName, 
                targetId: targetId,
                ...payload 
            };
            
            this.socket.emit('data', packet);
        },

        // Métodos de Sistema
        guardar: function(type, content, extra) {
            this.socket.emit('data', { action: 'SYS_SAVE', type, content, extra });
        },
        
        obtenerEsquema: function() { return this.localState; },
        obtenerMiId: function() { return this.socket ? this.socket.id : null; },
        desconectar: function() { if (this.socket) this.socket.disconnect(); }
    };

    global.EngineSDK = EngineSDK;

})(window);