const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mediasoup = require("mediasoup");
const cors = require("cors");
const config = require("./config");

const app = express();
app.use(cors());
app.use(express.json());

// Remove CSP headers that might be set elsewhere
app.use((req, res, next) => {
  res.removeHeader('Content-Security-Policy');
  res.removeHeader('X-Content-Security-Policy');
  res.removeHeader('X-WebKit-CSP');
  next();
});

// Serve static files from configured path
app.use(config.urlPrefix, express.static(config.publicPath));

const server = http.createServer(app);
const io = new Server(server, {
  path: config.socketPath,
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

let worker;
let router;

// Room Manager for separate rooms
const RoomManager = {
  rooms: new Map(), // pageType -> RoomState
  
  getRoom(pageType) {
    if (!this.rooms.has(pageType)) {
      this.rooms.set(pageType, this.createRoomState());
    }
    return this.rooms.get(pageType);
  },
  
  createRoomState() {
    return {
      // User management
      users: new Map(),
      availableIndexes: Array.from({ length: config.maxUsers }, (_, i) => i),
      
      // Media management  
      transports: new Map(),
      producers: new Map(),
      screenProducers: new Map(),
      
      // Counters
      userCounter: 0,
      presentationCounter: 0,
      availablePresentationIndexes: Array.from({ length: config.maxScreenShares }, (_, i) => i),
      
      // Constants
      MAX_USERS: config.maxUsers,
      MAX_SCREEN_SHARES: config.maxScreenShares,
      
      // Helper methods
      isRoomFull() {
        return this.users.size >= this.MAX_USERS;
      },
      
      getScreenShareCount() {
        return this.screenProducers.size;
      },
      
      getNextUserIndex() {
        return this.availableIndexes.length > 0 ? this.availableIndexes.shift() : null;
      },
      
      releaseUserIndex(userIndex) {
        if (userIndex !== null && userIndex >= 0 && userIndex < this.MAX_USERS) {
          this.availableIndexes.push(userIndex);
          this.availableIndexes.sort((a, b) => a - b);
        }
      },
      
      getNextPresentationIndex() {
        return this.availablePresentationIndexes.length > 0 ? this.availablePresentationIndexes.shift() : null;
      },
      
      releasePresentationIndex(presentationIndex) {
        if (presentationIndex !== null && presentationIndex >= 0 && presentationIndex < this.MAX_SCREEN_SHARES) {
          this.availablePresentationIndexes.push(presentationIndex);
          this.availablePresentationIndexes.sort((a, b) => a - b);
        }
      },
      
      getUserBySocketId(socketId) {
        return this.users.get(socketId);
      },

      getProducersForUser(socketId) {
        const userProducers = [];
        this.producers.forEach((producerData, producerId) => {
          if (producerData.socketId === socketId) {
            userProducers.push({
              id: producerId,
              ...producerData
            });
          }
        });
        return userProducers;
      },

      getAllProducers() {
        const producersList = [];
        this.producers.forEach((producerData, producerId) => {
          const userState = this.users.get(producerData.socketId);
          const peerName = userState ? userState.name : 'Unknown';
          
          producersList.push({
            id: producerId,
            socketId: producerData.socketId,
            kind: producerData.kind,
            source: producerData.source,
            peerName: peerName,
            isScreen: producerData.source === 'screen',
            userIndex: userState ? userState.userIndex : 0,
            presentationIndex: producerData.presentationIndex
          });
        });
        return producersList;
      },

      getAllUsers(excludeSocketId = null) {
        const usersList = [];
        this.users.forEach((userState, socketId) => {
          if (socketId !== excludeSocketId) {
            usersList.push({
              socketId: socketId,
              name: userState.name,
              userIndex: userState.userIndex,
              videoEnabled: userState.videoEnabled,
              audioEnabled: userState.audioEnabled
            });
          }
        });
        return usersList;
      },

      removeUserScreenShares(socketId) {
        const removedProducers = [];
        this.producers.forEach((producerData, producerId) => {
          if (producerData.socketId === socketId && producerData.source === 'screen') {
            if (producerData.presentationIndex !== null) {
              this.releasePresentationIndex(producerData.presentationIndex);
            }
            
            if (producerData.producer) {
              producerData.producer.close();
            }
            this.producers.delete(producerId);
            this.screenProducers.delete(producerId);
            removedProducers.push(producerId);
          }
        });
        return removedProducers;
      },

      cleanupUser(socketId) {
        const userState = this.users.get(socketId);
        
        this.users.delete(socketId);
        
        if (userState) {
          this.releaseUserIndex(userState.userIndex);
        }
        
        this.producers.forEach((producerData, producerId) => {
          if (producerData.socketId === socketId) {
            if (producerData.source === 'screen') {
              if (producerData.presentationIndex !== null) {
                this.releasePresentationIndex(producerData.presentationIndex);
              }
              this.screenProducers.delete(producerId);
            }
            if (producerData.producer) {
              producerData.producer.close();
            }
            this.producers.delete(producerId);
          }
        });
        
        this.transports.forEach((transportData, transportId) => {
          if (transportData.socketId === socketId) {
            if (transportData.transport) {
              transportData.transport.close();
            }
            this.transports.delete(transportId);
          }
        });
      },

      getRoomState() {
        return {
          users: this.getAllUsers(),
          producers: this.getAllProducers(),
          userCount: this.users.size,
          maxUsers: this.MAX_USERS,
          screenShareCount: this.getScreenShareCount(),
          maxScreenShares: this.MAX_SCREEN_SHARES,
          availableIndexes: this.availableIndexes,
          availablePresentationIndexes: this.availablePresentationIndexes
        };
      },
      
      printState(roomName) {
        console.log(`\n=== ROOM STATE: ${roomName} ===`);
        console.log(`Users: ${this.users.size}/${this.MAX_USERS}`);
        console.log(`Screen shares: ${this.screenProducers.size}/${this.MAX_SCREEN_SHARES}`);
        console.log(`Transports: ${this.transports.size}`);
        console.log(`Producers: ${this.producers.size}`);
        console.log('========================\n');
      }
    };
  }
};

// Initialize mediasoup
async function initializeMediasoup() {
  try {
    console.log("🔄 Initializing mediasoup...");
    
    worker = await mediasoup.createWorker({
      logLevel: 'warn',
      rtcMinPort: 40000,
      rtcMaxPort: 49999
    });
    
    console.log("✅ Mediasoup worker created");
    
    router = await worker.createRouter({
      mediaCodecs: config.mediaCodecs
    });
    
    console.log("✅ Mediasoup router created");
    
    worker.on('died', () => {
      console.error('❌ Mediasoup worker died, exiting...');
      process.exit(1);
    });
    
  } catch (error) {
    console.error("❌ Failed to initialize mediasoup:", error);
    process.exit(1);
  }
}

// Middleware for checking initialization
app.use((req, res, next) => {
  if (!router) {
    return res.status(503).json({ error: "Media server not ready" });
  }
  next();
});

// Serve page selector as main page
app.get(`${config.urlPrefix}/`, (req, res) => {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WebRTC Conference - Page Selector</title>
    <style>
        body { 
            font-family: Arial, sans-serif; 
            margin: 0; 
            padding: 20px; 
            background: #1a1a1a; 
            color: white; 
        }
        .container { 
            max-width: 800px; 
            margin: 0 auto; 
            text-align: center; 
        }
        .page-grid { 
            display: grid; 
            grid-template-columns: repeat(2, 1fr); 
            gap: 20px; 
            margin-top: 40px; 
        }
        .page-card { 
            background: #2d2d2d; 
            padding: 30px; 
            border-radius: 10px; 
            cursor: pointer;
            transition: all 0.3s ease;
            border: 2px solid #444;
        }
        .page-card:hover { 
            background: #3d3d3d; 
            border-color: #666;
            transform: translateY(-2px);
        }
        .page-card.disabled { 
            opacity: 0.5; 
            cursor: not-allowed; 
        }
        .page-icon { 
            font-size: 48px; 
            margin-bottom: 15px; 
        }
        .page-title { 
            font-size: 20px; 
            margin-bottom: 10px; 
        }
        .page-desc { 
            color: #ccc; 
            font-size: 14px; 
        }
        .status-badge {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 12px;
            font-size: 12px;
            margin-top: 10px;
        }
        .status-available {
            background: #2e7d32;
            color: white;
        }
        .status-occupied {
            background: #d32f2f;
            color: white;
        }
    </style>
</head>
<body>
    <div class="container">
        <header class="header">
            <h1>WebRTC Video Conference</h1>
            <p class="subtitle">Select your room</p>
        </header>

        <div class="page-grid">
            <div class="page-card" data-page="webcam1" onclick="selectPage('webcam1')">
                <div class="page-icon">📹</div>
                <div class="page-title">Webcam Room 1</div>
                <div class="page-desc">Video conference room 1</div>
                <div class="status-badge status-available" id="status-webcam1">Available</div>
            </div>
            
            <div class="page-card" data-page="webcam2" onclick="selectPage('webcam2')">
                <div class="page-icon">📹</div>
                <div class="page-title">Webcam Room 2</div>
                <div class="page-desc">Video conference room 2</div>
                <div class="status-badge status-available" id="status-webcam2">Available</div>
            </div>
            
            <div class="page-card" data-page="webcam3" onclick="selectPage('webcam3')">
                <div class="page-icon">📹</div>
                <div class="page-title">Webcam Room 3</div>
                <div class="page-desc">Video conference room 3</div>
                <div class="status-badge status-available" id="status-webcam3">Available</div>
            </div>
            
            <div class="page-card" data-page="screen" onclick="selectPage('screen')">
                <div class="page-icon">🖥️</div>
                <div class="page-title">Screen Share Room</div>
                <div class="page-desc">Screen sharing room</div>
                <div class="status-badge status-available" id="status-screen">Available</div>
            </div>
        </div>
    </div>

    <script>
        function selectPage(pageType) {
            window.location.href = \`${config.urlPrefix}/page.html?type=\${pageType}\`;
        }

        async function checkAvailability() {
            try {
                const response = await fetch('${config.urlPrefix}/all-rooms-state');
                const data = await response.json();
                
                ['webcam1', 'webcam2', 'webcam3', 'screen'].forEach(page => {
                    const badge = document.getElementById(\`status-\${page}\`);
                    const card = document.querySelector(\`[data-page="\${page}"]\`);
                    
                    if (data[page] && data[page].isFull) {
                        badge.textContent = 'Occupied';
                        badge.className = 'status-badge status-occupied';
                        card.classList.add('disabled');
                    } else {
                        badge.textContent = 'Available';
                        badge.className = 'status-badge status-available';
                        card.classList.remove('disabled');
                    }
                });
            } catch (error) {
                console.error('Error checking availability:', error);
            }
        }

        checkAvailability();
        setInterval(checkAvailability, 5000);
    </script>
</body>
</html>`;
  res.send(html);
});

// Serve individual room page
app.get(`${config.urlPrefix}/page.html`, (req, res) => {
  const pageType = req.query.type || 'webcam1';
  const pageConfig = config.getPageConfig(pageType);
  
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${pageConfig.title}</title>
    <link rel="stylesheet" href="${config.urlPrefix}/style.css">
    <script>
        window.SERVER_CONFIG = {
            SOCKET_URL: "",
            URL_PREFIX: "${config.urlPrefix}",
            SOCKET_PATH: "${config.socketPath}",
            MAX_USERS: ${config.maxUsers},
            MAX_SCREEN_SHARES: ${config.maxScreenShares},
            PAGE_TYPE: "${pageType}"
        };
    </script>
</head>
<body>
    <div class="container">
        <header class="header">
            <h1 id="pageTitle">${pageConfig.title}</h1>
            <p class="subtitle">${pageConfig.description}</p>
        </header>

        <div class="controls">
            <div class="join-section">
                <input type="text" id="username" placeholder="Enter your name" value="${pageConfig.defaultName}">
                <button id="startBtn">Join ${pageType === 'screen' ? 'Screen Share' : 'Conference'}</button>
            </div>
            <div class="media-controls" id="mediaControls">
                ${pageType === 'screen' ? 
                  '<button class="control-btn screen-btn" id="screenShareBtn">📺 Start Screen Share</button>' : 
                  '<button class="control-btn screen-btn" id="screenShareBtn" style="display:none">📺 Share Screen</button>'
                }
                ${pageType !== 'screen' ? 
                  '<button class="control-btn video-btn active" id="toggleVideoBtn">📹 Video On</button>' : 
                  '<button class="control-btn video-btn active" id="toggleVideoBtn" style="display:none">📹 Video On</button>'
                }
                ${pageType !== 'screen' ? 
                  '<button class="control-btn audio-btn active" id="toggleAudioBtn">🎤 Audio On</button>' : 
                  '<button class="control-btn audio-btn active" id="toggleAudioBtn" style="display:none">🎤 Audio On</button>'
                }
                <button class="control-btn switch-video-btn" id="switchVideoBtn">🔄 Rearrange Videos</button>
            </div>
        </div>

        <div class="room-status" id="roomStatus">
            Users: <span id="peerCount">0</span>/${config.maxUsers} | Presentations: <span id="screenCount">0</span>/${config.maxScreenShares}
        </div>

        <!-- Users Grid -->
        <div class="video-grid" id="peersContainer">
            <div class="video-wrapper self">
                <div class="video-header">
                    <div class="video-title">You</div>
                    <div class="screen-number">scr0</div>
                    <div class="video-status" id="localStatus">Ready</div>
                </div>
                <video id="localVideo" autoplay muted playsinline></video>
            </div>
        </div>

        <!-- Presentations Section -->
        <div id="presentationsSection" class="presentations-section" style="display: none;">
            <div class="section-separator">
                <div class="separator-line"></div>
                <div class="separator-text">Screen Shares</div>
                <div class="separator-line"></div>
            </div>
            <div class="video-grid presentations-grid" id="presentationsContainer">
                <!-- Presentations will be added here dynamically -->
            </div>
        </div>
    </div>

    <!-- Video Switcher -->
    <div id="videoSwitcher" class="video-switcher">
        <div class="video-switcher-header">
            <div class="video-switcher-title">Rearrange Videos</div>
            <button class="video-switcher-close">&times;</button>
        </div>
        <div class="video-switcher-list" id="videoSwitcherList">
            <!-- Video sources will be populated here -->
        </div>
    </div>

    <!-- Swap Instructions -->
    <div id="swapInstructions" class="swap-instructions" style="display: none;">
        <h3>🎯 Swap Mode Active</h3>
        <p><strong>Source selected:</strong> <span id="swapSourceDisplay">scr0</span></p>
        <p>Now click on any other video in the grid to swap positions</p>
        <button class="swap-mode-btn exit" onclick="window.conference.cancelSwap()">Cancel Swap</button>
    </div>

    <script src="https://cdn.socket.io/4.7.2/socket.io.min.js"></script>
    <script src="${config.urlPrefix}/mediasoup.bundle.js"></script>
    <script src="${config.urlPrefix}/client.js"></script>
</body>
</html>`;
  res.send(html);
});

// HTTP endpoints
app.get(`${config.urlPrefix}/router-rtp-capabilities`, (req, res) => {
  if (!router) {
    return res.status(503).json({ error: "Media server not ready" });
  }
  res.json(router.rtpCapabilities);
});

app.post(`${config.urlPrefix}/create-transport`, async (req, res) => {
  try {
    if (!router) {
      return res.status(503).json({ error: "Media server not ready" });
    }

    const { socketId, direction, roomType } = req.body;

    if (!socketId || !roomType) {
      return res.status(400).json({ error: "Socket ID and room type are required" });
    }

    const room = RoomManager.getRoom(roomType);

    if (direction === 'send') {
      const userState = room.getUserBySocketId(socketId);
      if (!userState && room.isRoomFull()) {
        return res.status(403).json({ error: `Room ${roomType} is full. Maximum ${config.maxUsers} users allowed.` });
      }
    }

    const transport = await router.createWebRtcTransport({
      listenIps: [
        {
          ip: config.listenIp,
          announcedIp: config.announcedIp
        }
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: config.initialOutgoingBitrate,
    });

    room.transports.set(transport.id, {
      transport,
      socketId,
      direction
    });

    console.log(`🚚 Created ${direction} transport for ${socketId} in room ${roomType}: ${transport.id}`);

    res.json({
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    });
  } catch (error) {
    console.error("Error creating transport:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post(`${config.urlPrefix}/connect-transport`, async (req, res) => {
  try {
    if (!router) {
      return res.status(503).json({ error: "Media server not ready" });
    }
    
    const { transportId, dtlsParameters, roomType } = req.body;
    
    if (!roomType) {
      return res.status(400).json({ error: "Room type is required" });
    }
    
    const room = RoomManager.getRoom(roomType);
    const transportData = room.transports.get(transportId);

    if (!transportData) {
      return res.status(404).json({ error: "Transport not found" });
    }

    await transportData.transport.connect({ dtlsParameters });
    res.json({ success: true });
  } catch (error) {
    console.error("Error connecting transport:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post(`${config.urlPrefix}/produce`, async (req, res) => {
  try {
    if (!router) {
      return res.status(503).json({ error: "Media server not ready" });
    }
    
    const { transportId, kind, rtpParameters, socketId, source, roomType } = req.body;
    
    if (!roomType) {
      return res.status(400).json({ error: "Room type is required" });
    }
    
    const room = RoomManager.getRoom(roomType);
    const transportData = room.transports.get(transportId);

    if (!transportData) {
      return res.status(404).json({ error: "Transport not found" });
    }

    if (source === 'screen') {
      if (room.getScreenShareCount() >= room.MAX_SCREEN_SHARES) {
        return res.status(403).json({ error: `Maximum ${config.maxScreenShares} screen shares allowed in room ${roomType}` });
      }
    }

    const producer = await transportData.transport.produce({
      kind,
      rtpParameters
    });

    const producerData = {
      producer,
      socketId,
      kind,
      source: source || 'camera'
    };

    const userState = room.getUserBySocketId(socketId);
    const peerName = userState ? userState.name : 'Unknown';

    if (source === 'screen') {
      const presentationIndex = room.getNextPresentationIndex();
      if (presentationIndex === null) {
        return res.status(403).json({ error: `Maximum ${config.maxScreenShares} screen shares allowed in room ${roomType}` });
      }
      
      producerData.presentationIndex = presentationIndex;
      room.screenProducers.set(producer.id, producer);

      console.log(`🖥️ New screen share from ${socketId} in room ${roomType}: ${producer.id} (pr${presentationIndex})`);

      io.to(roomType).emit("new-presentation", {
        id: producer.id,
        socketId: socketId,
        kind: kind,
        peerName: peerName,
        presentationIndex: presentationIndex
      });

      io.to(roomType).emit('room-status', room.getRoomState());

    } else {
      console.log(`🎥 New ${kind} producer from ${socketId} in room ${roomType}: ${producer.id} (${source})`);

      socketId && io.to(roomType).except(socketId).emit("new-producer", {
        id: producer.id,
        socketId: socketId,
        kind: kind,
        source: source || 'camera',
        peerName: peerName,
        userIndex: userState ? userState.userIndex : 0
      });
    }

    room.producers.set(producer.id, producerData);
    res.json({ id: producer.id });
  } catch (error) {
    console.error("Error creating producer:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post(`${config.urlPrefix}/consume`, async (req, res) => {
  try {
    if (!router) {
      return res.status(503).json({ error: "Media server not ready" });
    }
    
    const { transportId, producerId, rtpCapabilities, roomType } = req.body;
    
    if (!roomType) {
      return res.status(400).json({ error: "Room type is required" });
    }
    
    const room = RoomManager.getRoom(roomType);
    const transportData = room.transports.get(transportId);
    const producerData = room.producers.get(producerId);

    if (!transportData) {
      return res.status(404).json({ error: "Transport not found" });
    }

    if (!producerData) {
      return res.status(404).json({ error: "Producer not found" });
    }

    if (!router.canConsume({ producerId, rtpCapabilities })) {
      return res.status(400).json({ error: "Cannot consume" });
    }

    const consumer = await transportData.transport.consume({
      producerId,
      rtpCapabilities,
      paused: false,
    });

    res.json({
      id: consumer.id,
      producerId: consumer.producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
    });
  } catch (error) {
    console.error("Error creating consumer:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get(`${config.urlPrefix}/producers/:roomType`, (req, res) => {
  const roomType = req.params.roomType;
  if (!config.isValidPageType(roomType)) {
    return res.status(400).json({ error: "Invalid room type" });
  }
  const room = RoomManager.getRoom(roomType);
  res.json(room.getAllProducers());
});

app.get(`${config.urlPrefix}/room-state/:roomType`, (req, res) => {
  const roomType = req.params.roomType;
  if (!config.isValidPageType(roomType)) {
    return res.status(400).json({ error: "Invalid room type" });
  }
  const room = RoomManager.getRoom(roomType);
  res.json(room.getRoomState());
});

app.get(`${config.urlPrefix}/all-rooms-state`, (req, res) => {
  const allRooms = {};
  config.availablePages.forEach(page => {
    const room = RoomManager.getRoom(page);
    allRooms[page] = {
      userCount: room.users.size,
      screenShareCount: room.getScreenShareCount(),
      isFull: room.isRoomFull()
    };
  });
  res.json(allRooms);
});

// Socket.IO
io.on("connection", (socket) => {
  if (!router) {
    socket.emit('media-server-error', { error: "Media server not ready" });
    socket.disconnect();
    return;
  }

  console.log("🔌 New socket connection:", socket.id);

  const roomType = socket.handshake.query.pageType;
  console.log(`📄 Requested room: ${roomType}`);

  if (!config.isValidPageType(roomType)) {
    socket.emit('invalid-room', { error: "Invalid room type" });
    socket.disconnect();
    return;
  }

  const room = RoomManager.getRoom(roomType);
  const pageConfig = config.getPageConfig(roomType);

  if (room.isRoomFull()) {
    socket.emit('room-full');
    socket.disconnect();
    console.log(`❌ Rejected connection from ${socket.id}: room ${roomType} full`);
    return;
  }

  const userIndex = room.getNextUserIndex();
  if (userIndex === null) {
    socket.emit('room-full');
    socket.disconnect();
    console.log(`❌ No available user index for ${socket.id} in room ${roomType}`);
    return;
  }

  socket.roomType = roomType;

  room.users.set(socket.id, {
    id: socket.id,
    name: pageConfig.defaultName,
    videoEnabled: true,
    audioEnabled: true,
    userIndex: userIndex
  });

  console.log(`✅ Peer connected to room ${roomType}: ${socket.id} assigned index: scr${userIndex}`);
  room.printState(roomType);

  socket.join(roomType);

  socket.emit('init', {
    userIndex: userIndex,
    pageType: roomType,
    pageConfig: pageConfig,
    currentUsers: room.getAllUsers(socket.id),
    currentProducers: room.getAllProducers()
  });

  socket.to(roomType).emit("user-joined", {
    socketId: socket.id,
    name: pageConfig.defaultName,
    userIndex: userIndex,
    videoEnabled: true,
    audioEnabled: true
  });

  io.to(roomType).emit('room-status', room.getRoomState());

  socket.on("set-name", (name) => {
    const room = RoomManager.getRoom(socket.roomType);
    const userState = room.getUserBySocketId(socket.id);
    if (userState) {
      userState.name = name;
      console.log(`📛 Peer ${socket.id} in room ${socket.roomType} set name to: ${name}`);

      socket.to(socket.roomType).emit("user-updated", {
        socketId: socket.id,
        name: name,
        videoEnabled: userState.videoEnabled,
        audioEnabled: userState.audioEnabled,
        userIndex: userState.userIndex
      });

      io.to(socket.roomType).emit('room-status', room.getRoomState());
    }
  });

  socket.on("toggle-video", (data) => {
    const room = RoomManager.getRoom(socket.roomType);
    const userState = room.getUserBySocketId(socket.id);
    if (userState) {
      userState.videoEnabled = data.enabled;
      socket.to(socket.roomType).emit("user-video-toggled", {
        socketId: socket.id,
        enabled: data.enabled
      });
    }
  });

  socket.on("toggle-audio", (data) => {
    const room = RoomManager.getRoom(socket.roomType);
    const userState = room.getUserBySocketId(socket.id);
    if (userState) {
      userState.audioEnabled = data.enabled;
      socket.to(socket.roomType).emit("user-audio-toggled", {
        socketId: socket.id,
        enabled: data.enabled
      });
    }
  });

  socket.on("stop-screen-share", () => {
    const room = RoomManager.getRoom(socket.roomType);
    console.log(`🖥️ User ${socket.id} in room ${socket.roomType} stopped screen sharing`);

    const removedProducers = room.removeUserScreenShares(socket.id);

    removedProducers.forEach(producerId => {
      io.to(socket.roomType).emit("presentation-ended", {
        producerId: producerId,
        socketId: socket.id
      });
    });

    io.to(socket.roomType).emit('room-status', room.getRoomState());

    console.log(`🗑️ Removed ${removedProducers.length} screen producers for ${socket.id} in room ${socket.roomType}`);
  });

  socket.on("disconnect", () => {
    const room = RoomManager.getRoom(socket.roomType);
    console.log(`❌ Peer disconnected from room ${socket.roomType}:`, socket.id);

    const userState = room.getUserBySocketId(socket.id);

    room.cleanupUser(socket.id);

    socket.to(socket.roomType).emit("user-left", {
      socketId: socket.id
    });

    room.producers.forEach((producerData, producerId) => {
      if (producerData.socketId === socket.id && producerData.source === 'screen') {
        io.to(socket.roomType).emit("presentation-ended", {
          producerId: producerId
        });
      }
    });

    io.to(socket.roomType).emit('room-status', room.getRoomState());

    console.log(`🗑️ Cleaned up resources for ${socket.id} in room ${socket.roomType}`);
    room.printState(socket.roomType);
  });
});

// Reset all rooms when server starts
function resetServerState() {
  config.availablePages.forEach(page => {
    const room = RoomManager.getRoom(page);
    room.users.clear();
    room.transports.clear();
    room.producers.clear();
    room.screenProducers.clear();
    room.availableIndexes = Array.from({ length: config.maxUsers }, (_, i) => i);
    room.availablePresentationIndexes = Array.from({ length: config.maxScreenShares }, (_, i) => i);
    room.userCounter = 0;
    room.presentationCounter = 0;
  });
  console.log("🔄 All rooms reset complete");
}

// Start server
async function startServer() {
  try {
    await initializeMediasoup();
    
    server.listen(config.port, () => {
      resetServerState();
      console.log("🚀 Server running on port", config.port);
      console.log(`👥 User limit per room: ${config.maxUsers} users`);
      console.log(`🖥️ Screen share limit per room: ${config.maxScreenShares} simultaneous shares`);
      console.log(`🌐 URL prefix: ${config.urlPrefix}`);
      console.log(`🔌 Socket path: ${config.socketPath}`);
      console.log(`📡 Announced IP: ${config.announcedIp}`);
      console.log(`🏠 Available rooms: ${config.availablePages.join(', ')}`);
    });
    
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

// Start server
startServer();
