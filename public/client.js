// Configuration - uses server-injected config or defaults
const CONFIG = window.SERVER_CONFIG || {
  SOCKET_URL: window.location.origin,
  URL_PREFIX: "/zzy",
  SOCKET_PATH: "/zzy/socket.io",
  MAX_USERS: 3,
  MAX_SCREEN_SHARES: 2,
  PAGE_TYPE: "webcam1"
};

console.log("🔧 Client configuration:", CONFIG);

class VideoConference {
    constructor() {
        this.socket = null;
        this.device = null;
        this.producerTransport = null;
        this.consumers = new Map();
        this.consumerTransports = new Map();
        this.producers = new Map();
        this.localStream = null;
        this.screenStream = null;
        this.isStarted = false;
        this.isSharingScreen = false;
        this.videoEnabled = true;
        this.audioEnabled = true;

        // Server-managed tracking
        this.userStates = new Map();
        this.presentations = new Map();
        this.myUserIndex = 0;
        this.activeScreenProducers = new Set();

        // Page type management
        this.pageType = CONFIG.PAGE_TYPE;
        this.isScreenPage = this.pageType === 'screen';

        // Buffer for events that arrive before device is ready
        this.pendingProducers = [];
        this.pendingPresentations = [];
        this.deviceReady = false;

        // Video switcher state
        this.currentMainVideo = null;
        this.isSwapMode = false;
        this.swapSource = null;
        this.swapTarget = null;

        this.initialize();
    }

    initialize() {
        this.setupEventListeners();
        this.updateRoomStatus();
        this.initializeVideoSwitcher();
        this.setupGlobalClickHandlers();
        this.updateUIForPageType();
    }

    setupEventListeners() {
        document.getElementById('startBtn').addEventListener('click', () => this.startConference());
        document.getElementById('screenShareBtn').addEventListener('click', () => this.toggleScreenShare());
        document.getElementById('toggleVideoBtn').addEventListener('click', () => this.toggleVideo());
        document.getElementById('toggleAudioBtn').addEventListener('click', () => this.toggleAudio());
    }

    setupGlobalClickHandlers() {
        document.body.addEventListener('click', (e) => {
            if (!this.isSwapMode) return;
            
            const videoWrapper = e.target.closest('.video-wrapper');
            if (!videoWrapper) return;
            
            if (videoWrapper.classList.contains('swap-source')) return;
            
            e.stopPropagation();
            e.preventDefault();
            
            this.handleVideoGridClick(videoWrapper);
        });
    }

    updateUIForPageType() {
        const header = document.querySelector('h1');
        const controls = document.getElementById('mediaControls');
        const screenShareBtn = document.getElementById('screenShareBtn');
        const videoBtn = document.getElementById('toggleVideoBtn');
        const audioBtn = document.getElementById('toggleAudioBtn');

        if (this.isScreenPage) {
            if (header) header.textContent = 'Screen Share Page';
            if (screenShareBtn) {
                screenShareBtn.textContent = '📺 Start Screen Share';
                screenShareBtn.style.display = 'block';
            }
            if (videoBtn) videoBtn.style.display = 'none';
            if (audioBtn) audioBtn.style.display = 'none';
        } else {
            if (header) header.textContent = `Webcam Page ${this.pageType?.replace('webcam', '') || '1'}`;
            if (screenShareBtn) screenShareBtn.style.display = 'none';
            if (videoBtn) videoBtn.style.display = 'block';
            if (audioBtn) audioBtn.style.display = 'block';
        }
    }

    // НОВАЯ ФУНКЦИЯ: Открыть видео в чистом окне
    openVideoInCleanWindow(videoElement, title = "Video") {
        if (!videoElement || !videoElement.srcObject) {
            console.error("❌ No video stream available");
            return;
        }

        const features = `
            width=${window.screen.width},
            height=${window.screen.height},
            left=0,
            top=0,
            menubar=no,
            toolbar=no,
            location=no,
            status=no,
            resizable=yes,
            scrollbars=no
        `;
        
        const newWindow = window.open('', '_blank', features);

        if (!newWindow) {
            alert("❌ Браузер заблокировал pop-up! Разрешите открытие окон для этого сайта.");
            return;
        }

        try {
            newWindow.document.title = title;
            newWindow.document.body.style.margin = "0";
            newWindow.document.body.style.padding = "0";
            newWindow.document.body.style.background = "black";
            newWindow.document.body.style.overflow = "hidden";

            const vid = newWindow.document.createElement("video");
            vid.autoplay = true;
            vid.playsInline = true;
            vid.controls = true;
            vid.style.cssText = `
                width: 100vw;
                height: 100vh;
                object-fit: contain;
                background: black;
                position: fixed;
                top: 0;
                left: 0;
                margin: 0;
                padding: 0;
            `;

            vid.srcObject = videoElement.srcObject;

            newWindow.document.body.appendChild(vid);

            const closeBtn = newWindow.document.createElement("button");
            closeBtn.textContent = "✕";
            closeBtn.style.cssText = `
                position: fixed;
                top: 10px;
                right: 10px;
                background: rgba(0,0,0,0.7);
                color: white;
                border: none;
                border-radius: 50%;
                width: 40px;
                height: 40px;
                font-size: 20px;
                cursor: pointer;
                z-index: 1000;
            `;
            closeBtn.onclick = () => newWindow.close();
            newWindow.document.body.appendChild(closeBtn);

            newWindow.onbeforeunload = () => {
                console.log("✅ Fullscreen video window closed");
            };

            console.log("✅ Video opened in fullscreen window");

        } catch (err) {
            console.error("❌ Error opening video window:", err);
            newWindow.close();
        }
    }

    // НОВАЯ ФУНКЦИЯ: Открыть локальную вебку в отдельном окне
    openLocalWebcamInNewWindow() {
        const localVideo = document.getElementById('localVideo');
        if (localVideo && localVideo.srcObject) {
            this.openVideoInCleanWindow(localVideo, "My Webcam");
        } else {
            alert("❌ Local webcam not available");
        }
    }

    // НОВАЯ ФУНКЦИЯ: Открыть удаленную вебку в отдельном окне
    openRemoteWebcamInNewWindow(socketId) {
        const remoteVideo = document.querySelector(`#user-${socketId} video`);
        if (remoteVideo && remoteVideo.srcObject) {
            const userState = this.userStates.get(socketId);
            const title = userState ? `${userState.name}'s Webcam` : "Remote Webcam";
            this.openVideoInCleanWindow(remoteVideo, title);
        } else {
            alert("❌ Remote webcam not available");
        }
    }

    // НОВАЯ ФУНКЦИЯ: Открыть демонстрацию экрана в отдельном окне
    openScreenShareInNewWindow(producerId) {
        const screenVideo = document.querySelector(`#presentation-${producerId} video`);
        if (screenVideo && screenVideo.srcObject) {
            const presentation = this.presentations.get(producerId);
            const title = presentation ? `${presentation.peerName}'s Screen` : "Screen Share";
            this.openVideoInCleanWindow(screenVideo, title);
        } else {
            alert("❌ Screen share not available");
        }
    }

    // ОБНОВЛЯЕМ ФУНКЦИЮ: Добавляем кнопки ко всем существующим элементам
    addFullscreenButtonsToExistingElements() {
        // Добавляем кнопку к локальному видео (если еще нет)
        const localVideoWrapper = document.querySelector('.video-wrapper.self');
        if (localVideoWrapper && !localVideoWrapper.querySelector('.fullscreen-btn')) {
            const fullscreenBtn = document.createElement('button');
            fullscreenBtn.className = 'fullscreen-btn';
            fullscreenBtn.title = 'Open my webcam in fullscreen';
            fullscreenBtn.textContent = '⛶';
            fullscreenBtn.style.cssText = `
                position: absolute;
                top: 10px;
                right: 10px;
                background: rgba(0,0,0,0.7);
                color: white;
                border: none;
                border-radius: 4px;
                padding: 5px;
                cursor: pointer;
                z-index: 10;
            `;
            fullscreenBtn.addEventListener('click', () => {
                this.openLocalWebcamInNewWindow();
            });
            
            localVideoWrapper.style.position = 'relative';
            localVideoWrapper.appendChild(fullscreenBtn);
        }

        // Добавляем кнопки ко всем удаленным пользователям
        this.userStates.forEach((user, socketId) => {
            if (socketId !== this.socket.id) {
                const userElement = document.getElementById(`user-${socketId}`);
                if (userElement && !userElement.querySelector('.fullscreen-btn')) {
                    const fullscreenBtn = document.createElement('button');
                    fullscreenBtn.className = 'fullscreen-btn';
                    fullscreenBtn.title = 'Open in fullscreen';
                    fullscreenBtn.textContent = '⛶';
                    fullscreenBtn.style.cssText = `
                        background: rgba(0,0,0,0.7);
                        color: white;
                        border: none;
                        border-radius: 4px;
                        padding: 5px 8px;
                        cursor: pointer;
                        font-size: 14px;
                        margin-left: 5px;
                    `;
                    fullscreenBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.openRemoteWebcamInNewWindow(socketId);
                    });

                    const videoHeader = userElement.querySelector('.video-header');
                    if (videoHeader) {
                        videoHeader.appendChild(fullscreenBtn);
                    }
                }
            }
        });

        // Добавляем кнопки ко всем демонстрациям экрана
        this.presentations.forEach((presentation, producerId) => {
            const presentationElement = document.getElementById(`presentation-${producerId}`);
            if (presentationElement && !presentationElement.querySelector('.fullscreen-btn')) {
                const fullscreenBtn = document.createElement('button');
                fullscreenBtn.className = 'fullscreen-btn';
                fullscreenBtn.title = 'Open in fullscreen';
                fullscreenBtn.textContent = '⛶';
                fullscreenBtn.style.cssText = `
                    background: rgba(0,0,0,0.7);
                    color: white;
                    border: none;
                    border-radius: 4px;
                    padding: 5px 8px;
                    cursor: pointer;
                    font-size: 14px;
                    margin-left: 5px;
                `;
                fullscreenBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.openScreenShareInNewWindow(producerId);
                });

                const videoHeader = presentationElement.querySelector('.video-header');
                if (videoHeader) {
                    videoHeader.appendChild(fullscreenBtn);
                }
            }
        });
    }

    // НОВАЯ ФУНКЦИЯ: Принудительное обновление кнопок (можно вызвать из консоли)
    refreshFullscreenButtons() {
        this.addFullscreenButtonsToExistingElements();
        console.log("✅ Fullscreen buttons refreshed");
    }

    handleVideoGridClick(videoWrapper) {
        if (!this.isSwapMode || !this.swapSource) return;

        const screenNumberEl = videoWrapper.querySelector('.screen-number');
        if (!screenNumberEl) return;
        
        const screenId = screenNumberEl.textContent;
        
        let videoId, videoType;
        
        if (videoWrapper.classList.contains('self')) {
            videoId = 'local';
            videoType = 'camera';
        } else if (videoWrapper.id.startsWith('user-')) {
            videoId = videoWrapper.id;
            videoType = 'user';
        } else if (videoWrapper.id.startsWith('presentation-')) {
            videoId = videoWrapper.id;
            videoType = 'presentation';
        } else {
            return;
        }

        console.log(`🎯 Video grid click: ${videoId} on ${screenId}`);

        if (this.swapSource) {
            this.swapTarget = { id: videoId, screen: screenId };
            this.highlightSwapTarget(screenId);
            this.performSwap();
        }
    }

    initializeVideoSwitcher() {
        this.videoSwitcher = document.getElementById('videoSwitcher');
        this.videoSwitcherList = document.getElementById('videoSwitcherList');
        this.isSwapMode = false;

        document.querySelector('.video-switcher-close').addEventListener('click', () => {
            this.hideVideoSwitcher();
            this.cancelSwap();
        });

        document.addEventListener('click', (e) => {
            if (this.videoSwitcher.style.display === 'block' &&
                !this.videoSwitcher.contains(e.target) &&
                !e.target.classList.contains('switch-video-btn')) {
                this.hideVideoSwitcher();
                this.cancelSwap();
            }
        });

        this.addSwitchVideoButton();
    }

    addSwitchVideoButton() {
        const mediaControls = document.getElementById('mediaControls');
        const switchBtn = document.createElement('button');
        switchBtn.className = 'control-btn switch-video-btn';
        switchBtn.id = 'switchVideoBtn';
        switchBtn.innerHTML = '🔄 Rearrange Videos';
        switchBtn.addEventListener('click', () => this.toggleVideoSwitcher());

        mediaControls.appendChild(switchBtn);
    }

    toggleVideoSwitcher() {
        if (this.videoSwitcher.style.display === 'block') {
            this.hideVideoSwitcher();
        } else {
            this.showVideoSwitcher();
        }
    }

    showVideoSwitcher() {
        this.updateVideoSwitcherList();
        this.videoSwitcher.style.display = 'block';
    }

    hideVideoSwitcher() {
        this.videoSwitcher.style.display = 'none';
    }

    updateVideoSwitcherList() {
        this.videoSwitcherList.innerHTML = '';

        this.addSwitcherItem('local', 'Your Camera', 'camera', 'scr' + this.myUserIndex);

        this.userStates.forEach((user, socketId) => {
            if (socketId !== this.socket.id) {
                this.addSwitcherItem(`user-${socketId}`, `${user.name}`, 'user', 'scr' + user.userIndex);
            }
        });

        this.presentations.forEach((presentation, producerId) => {
            const isOwn = presentation.socketId === this.socket.id;
            const name = isOwn ? 'Your Screen Share' : `${presentation.peerName}'s Screen`;
            this.addSwitcherItem(`presentation-${producerId}`, name, 'presentation', 'pr' + presentation.presentationIndex);
        });

        console.log(`📊 Switcher updated: ${this.userStates.size} users, ${this.presentations.size} presentations`);
    }

    addSwitcherItem(id, name, type, screenId) {
        const item = document.createElement('div');
        item.className = 'switcher-item';
        item.dataset.id = id;
        item.dataset.type = type;
        item.dataset.screen = screenId;

        const typeIcons = {
            'camera': '👤',
            'user': '👥',
            'presentation': '🖥️'
        };

        const typeLabels = {
            'camera': 'Camera',
            'user': 'User',
            'presentation': 'Screen Share'
        };

        item.innerHTML = `
            <div class="switcher-thumbnail" id="thumb-${id}">
                <span>${typeIcons[type]}</span>
            </div>
            <div class="switcher-info">
                <div class="switcher-name">${name}</div>
                <div class="switcher-type">
                    <span>${screenId}</span> • ${typeLabels[type]}
                </div>
            </div>
            <div class="switcher-controls">
                <button class="switcher-btn swap-btn" title="Select to Swap">🔀 Select</button>
            </div>
        `;

        item.querySelector('.swap-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            this.selectForSwap(id, screenId);
        });

        this.updateSwitcherThumbnail(id);
        this.videoSwitcherList.appendChild(item);
    }

    updateSwitcherThumbnail(id) {
        const thumb = document.getElementById(`thumb-${id}`);
        if (!thumb) return;

        const videoElement = this.findVideoElementById(id);
        if (videoElement && videoElement.srcObject) {
            const preview = document.createElement('video');
            preview.srcObject = videoElement.srcObject;
            preview.muted = true;
            preview.playsInline = true;
            preview.style.width = '100%';
            preview.style.height = '100%';
            preview.style.objectFit = 'cover';

            thumb.innerHTML = '';
            thumb.appendChild(preview);
        }
    }

    findVideoElementById(id) {
        if (id === 'local') {
            return document.getElementById('localVideo');
        }

        const [type, specificId] = id.split('-');
        switch(type) {
            case 'user':
                const userElement = document.getElementById(`user-${specificId}`);
                return userElement ? userElement.querySelector('video') : null;
            case 'presentation':
                const presentationElement = document.getElementById(`presentation-${specificId}`);
                return presentationElement ? presentationElement.querySelector('video') : null;
            default:
                return null;
        }
    }

    findVideoContainerByScreen(screenId) {
        const videoWrappers = document.querySelectorAll('.video-wrapper');
        
        for (const wrapper of videoWrappers) {
            const screenNumberEl = wrapper.querySelector('.screen-number');
            if (screenNumberEl) {
                if (screenNumberEl.textContent === screenId) {
                    return wrapper;
                }
            }
        }
        
        return null;
    }

    selectForSwap(sourceId, screenId) {
        console.log(`🔀 Selecting for swap: ${sourceId} on ${screenId}`);

        if (!this.swapSource) {
            this.swapSource = { id: sourceId, screen: screenId };
            this.isSwapMode = true;
            this.highlightSwapSource(screenId);
            this.showSwapInstructions();
            this.hideVideoSwitcher();
            
            console.log('✅ Swap mode activated - click any video in the grid to swap');
            
            this.enableSwapModeVisuals();
        } else {
            this.swapTarget = { id: sourceId, screen: screenId };
            this.highlightSwapTarget(screenId);
            this.performSwap();
        }
    }

    enableSwapModeVisuals() {
        const allWrappers = document.querySelectorAll('.video-wrapper:not(.swap-source)');
        allWrappers.forEach(wrapper => {
            wrapper.style.cursor = 'pointer';
            wrapper.style.opacity = '0.9';
            wrapper.style.transition = 'all 0.3s ease';
        });
        
        document.body.classList.add('swap-mode');
    }

    disableSwapModeVisuals() {
        const allWrappers = document.querySelectorAll('.video-wrapper');
        allWrappers.forEach(wrapper => {
            wrapper.style.cursor = '';
            wrapper.style.opacity = '';
        });
        
        document.body.classList.remove('swap-mode');
    }

    highlightSwapSource(screenId) {
        this.clearSwapHighlights();

        const sourceContainer = this.findVideoContainerByScreen(screenId);
        if (sourceContainer) {
            sourceContainer.classList.add('swap-source');
            sourceContainer.style.cursor = 'default';
        }

        console.log(`🎯 Swap source highlighted: ${screenId}`);
    }

    highlightSwapTarget(screenId) {
        const targetContainer = this.findVideoContainerByScreen(screenId);
        if (targetContainer) {
            targetContainer.classList.add('swap-target');
        }
        
        console.log(`🎯 Swap target highlighted: ${screenId}`);
    }

    clearSwapHighlights() {
        const videoWrappers = document.querySelectorAll('.video-wrapper');
        videoWrappers.forEach(wrapper => {
            wrapper.classList.remove('swap-source', 'swap-target');
            wrapper.style.cursor = '';
            wrapper.style.opacity = '';
        });
    }

    showSwapInstructions() {
        const instructions = document.getElementById('swapInstructions');
        if (instructions) {
            instructions.style.display = 'block';
        }
    }

    hideSwapInstructions() {
        const instructions = document.getElementById('swapInstructions');
        if (instructions) {
            instructions.style.display = 'none';
        }
    }

    performSwap() {
        if (!this.swapSource || !this.swapTarget) {
            console.error('Cannot perform swap: source or target missing');
            this.cancelSwap();
            return;
        }

        if (this.swapSource.id === this.swapTarget.id) {
            console.log('⚠️ Cannot swap with same video');
            this.cancelSwap();
            return;
        }

        console.log(`🔄 Performing swap: ${this.swapSource.screen} ↔ ${this.swapTarget.screen}`);

        const sourceContainer = this.findVideoContainerByScreen(this.swapSource.screen);
        const targetContainer = this.findVideoContainerByScreen(this.swapTarget.screen);

        if (!sourceContainer || !targetContainer) {
            console.error('Cannot perform swap: containers not found');
            this.cancelSwap();
            return;
        }

        const sourceParent = sourceContainer.parentNode;
        const targetParent = targetContainer.parentNode;

        if (sourceParent === targetParent) {
            this.swapVideoContainers(sourceContainer, targetContainer);
        } else {
            this.swapCrossContainers(sourceContainer, targetContainer);
        }

        this.completeSwap();
    }

    swapCrossContainers(container1, container2) {
        const parent1 = container1.parentNode;
        const parent2 = container2.parentNode;
        
        if (!parent1 || !parent2) {
            console.error('Cannot swap: parent containers not found');
            return;
        }

        console.log(`🔄 Cross-container swap between ${parent1.id} and ${parent2.id}`);

        parent1.removeChild(container1);
        parent2.removeChild(container2);

        parent1.appendChild(container2);
        parent2.appendChild(container1);

        console.log(`✅ Cross-container swap completed`);
    }

    swapVideoContainers(container1, container2) {
        const parent1 = container1.parentNode;
        const parent2 = container2.parentNode;
        
        if (!parent1 || !parent2) {
            console.error('Cannot swap: parent containers not found');
            return;
        }

        const temp = document.createElement('div');
        
        parent2.insertBefore(temp, container2);
        parent1.insertBefore(container2, container1);
        parent2.insertBefore(container1, temp);
        parent2.removeChild(temp);

        console.log(`✅ Swapped video containers between positions`);
    }

    completeSwap() {
        console.log('✅ Swap completed');

        this.swapSource = null;
        this.swapTarget = null;
        this.isSwapMode = false;

        this.clearSwapHighlights();
        this.hideSwapInstructions();
        this.disableSwapModeVisuals();
        this.updateVideoSwitcherList();
    }

    cancelSwap() {
        console.log('🚫 Swap cancelled');

        this.swapSource = null;
        this.swapTarget = null;
        this.isSwapMode = false;

        this.clearSwapHighlights();
        this.hideSwapInstructions();
        this.disableSwapModeVisuals();
        this.updateVideoSwitcherList();
    }

    exitSwapMode() {
        this.cancelSwap();
        this.hideVideoSwitcher();
    }

    async startConference() {
        if (this.isStarted) return;

        try {
            const startBtn = document.getElementById('startBtn');
            startBtn.disabled = true;
            startBtn.textContent = 'Joining...';

            console.log("🔌 Connecting to signaling server...");
            this.socket = io(CONFIG.SOCKET_URL, {
                path: CONFIG.SOCKET_PATH,
                transports: ["polling", "websocket"],
                query: {
                    pageType: this.pageType
                }
            });
            this.setupSocketListeners();

            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error("Socket connection timeout")), 10000);

                this.socket.once('connect', () => {
                    clearTimeout(timeout);
                    console.log("✅ Socket connected, proceeding with media...");
                    resolve();
                });

                this.socket.once('connect_error', (error) => {
                    clearTimeout(timeout);
                    reject(error);
                });
            });

            console.log("🎥 Requesting user media...");
            
            if (this.isScreenPage) {
                this.localStream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true
                    }
                });
            } else {
                this.localStream = await navigator.mediaDevices.getUserMedia({
                    video: {
                        width: { ideal: 1280 },
                        height: { ideal: 720 },
                        frameRate: { ideal: 30 }
                    },
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true
                    }
                });
            }

            this.setupLocalVideo();

            const username = document.getElementById('username').value.trim() || (this.isScreenPage ? 'Presenter' : 'User');
            console.log(`📛 Setting username: ${username}`);
            this.socket.emit('set-name', username);

            console.log("📡 Loading router capabilities...");
            const rtpCapabilities = await this.fetchJSON(`${CONFIG.URL_PREFIX}/router-rtp-capabilities`);

            console.log("🔧 Initializing device...");
            this.device = new mediasoupClient.Device();
            await this.device.load({ routerRtpCapabilities: rtpCapabilities });

            this.deviceReady = true;
            console.log("✅ Device loaded with router capabilities");

            await this.processPendingProducers();

            console.log("🚚 Creating producer transport...");
            try {
                await this.createProducerTransport();

                console.log("🎬 Producing camera tracks...");
                await this.produceCameraTracks();
            } catch (transportError) {
                if (transportError.message.includes('Room is full')) {
                    console.warn('⚠️ User joined as receiver-only (room full)');
                } else {
                    throw transportError;
                }
            }

            document.getElementById('mediaControls').style.display = 'flex';

            this.isStarted = true;
            startBtn.textContent = 'Joined';

            console.log('✅ Conference started successfully');

        } catch (error) {
            console.error('❌ Error starting conference:', error);
            alert('Failed to join conference: ' + error.message);
            document.getElementById('startBtn').disabled = false;
            document.getElementById('startBtn').textContent = this.isScreenPage ? 'Join Screen Share' : 'Join Conference';

            if (this.localStream) {
                this.localStream.getTracks().forEach(track => track.stop());
                this.localStream = null;
            }
            if (this.socket) {
                this.socket.disconnect();
                this.socket = null;
            }
        }
    }

    setupLocalVideo() {
        const localVideo = document.getElementById('localVideo');
        localVideo.srcObject = this.localStream;
        localVideo.muted = true;
        localVideo.playsInline = true;
        
        // Добавляем кнопку полноэкранного режима для локального видео
        const localVideoWrapper = document.querySelector('.video-wrapper.self');
        if (localVideoWrapper && !localVideoWrapper.querySelector('.fullscreen-btn')) {
            const fullscreenBtn = document.createElement('button');
            fullscreenBtn.className = 'fullscreen-btn';
            fullscreenBtn.title = 'Open my webcam in fullscreen';
            fullscreenBtn.textContent = '⛶';
            fullscreenBtn.style.cssText = `
                position: absolute;
                top: 10px;
                right: 10px;
                background: rgba(0,0,0,0.7);
                color: white;
                border: none;
                border-radius: 4px;
                padding: 5px;
                cursor: pointer;
                z-index: 10;
            `;
            fullscreenBtn.addEventListener('click', () => {
                this.openLocalWebcamInNewWindow();
            });
            
            localVideoWrapper.style.position = 'relative';
            localVideoWrapper.appendChild(fullscreenBtn);
        }
        
        if (this.isScreenPage && !this.localStream.getVideoTracks().length) {
            localVideo.style.display = 'none';
        }
        
        document.getElementById('localStatus').textContent = 'Connected';
    }

    async createProducerTransport() {
        try {
            const transportData = await this.fetchJSON(`${CONFIG.URL_PREFIX}/create-transport`, {
                method: 'POST',
                body: JSON.stringify({
                    socketId: this.socket.id,
                    direction: 'send',
                    roomType: this.pageType
                })
            });

            this.producerTransport = this.device.createSendTransport(transportData);

            this.producerTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
                try {
                    console.log("🔗 Connecting producer transport...");
                    await this.fetchJSON(`${CONFIG.URL_PREFIX}/connect-transport`, {
                        method: 'POST',
                        body: JSON.stringify({
                            transportId: this.producerTransport.id,
                            dtlsParameters,
                            roomType: this.pageType
                        })
                    });
                    console.log("✅ Producer transport connected");
                    callback();
                } catch (error) {
                    console.error("❌ Producer transport connection failed:", error);
                    errback(error);
                }
            });

            this.producerTransport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
                try {
                    console.log(`📦 Producing ${kind} track...`);
                    const { id } = await this.fetchJSON(`${CONFIG.URL_PREFIX}/produce`, {
                        method: 'POST',
                        body: JSON.stringify({
                            transportId: this.producerTransport.id,
                            kind,
                            rtpParameters,
                            socketId: this.socket.id,
                            source: this.isSharingScreen ? 'screen' : 'camera',
                            roomType: this.pageType
                        })
                    });
                    console.log(`✅ Produced ${kind} track: ${id}`);
                    callback({ id });

                    if (this.isSharingScreen) {
                        this.activeScreenProducers.add(id);
                        console.log(`📝 Added screen producer to active set: ${id}`);
                    }
                } catch (error) {
                    console.error(`❌ Produce failed for ${kind}:`, error);
                    errback(error);
                }
            });

            this.producerTransport.on('connectionstatechange', (state) => {
                console.log(`🔗 Producer transport state: ${state}`);
            });

        } catch (error) {
            if (error.message.includes('Room is full')) {
                console.warn('⚠️ Room is full, but user is already connected. Continuing as receive-only.');
                return;
            }
            console.error("❌ Failed to create producer transport:", error);
            throw error;
        }
    }

    async produceCameraTracks() {
        try {
            const audioTrack = this.localStream.getAudioTracks()[0];
            if (audioTrack) {
                const producer = await this.producerTransport.produce({ track: audioTrack });
                this.producers.set('camera-audio', producer);
                console.log("✅ Produced camera audio");
            }

            const videoTrack = this.localStream.getVideoTracks()[0];
            if (videoTrack) {
                const producer = await this.producerTransport.produce({ track: videoTrack });
                this.producers.set('camera-video', producer);
                console.log("✅ Produced camera video");
            }
        } catch (error) {
            console.error("❌ Failed to produce camera tracks:", error);
            throw error;
        }
    }

    async produceScreenTracks() {
        if (!this.screenStream) return;

        console.log("🔄 Starting to produce screen tracks...");

        try {
            const screenVideoTrack = this.screenStream.getVideoTracks()[0];
            if (screenVideoTrack) {
                const producer = await this.producerTransport.produce({ track: screenVideoTrack });
                this.producers.set('screen-video', producer);
                console.log("✅ Screen video producer created:", producer.id);
            } else {
                console.log("❌ No screen video track found");
            }

            const screenAudioTrack = this.screenStream.getAudioTracks()[0];
            if (screenAudioTrack) {
                const producer = await this.producerTransport.produce({ track: screenAudioTrack });
                this.producers.set('screen-audio', producer);
                console.log("✅ Screen audio producer created:", producer.id);
            } else {
                console.log("ℹ️ No screen audio track available");
            }
        } catch (error) {
            console.error("❌ Failed to produce screen tracks:", error);
            throw error;
        }
    }

    setupSocketListeners() {
        this.socket.on('connect', () => {
            console.log('✅ Connected to signaling server');
            this.updateRoomStatus();
        });

        this.socket.on('disconnect', (reason) => {
            console.log('❌ Disconnected from signaling server:', reason);
            this.handleDisconnect();
        });

        this.socket.on('connect_error', (error) => {
            console.error('❌ Connection error:', error);
        });

        this.socket.on('room-full', () => {
            alert(`Conference room is full (maximum ${CONFIG.MAX_USERS} users). Please try again later.`);
            document.getElementById('startBtn').disabled = false;
            document.getElementById('startBtn').textContent = this.isScreenPage ? 'Join Screen Share' : 'Join Conference';
        });

        this.socket.on('invalid-room', () => {
            alert('Invalid room type. Please select a valid room.');
            window.location.href = `${CONFIG.URL_PREFIX}/`;
        });

        this.socket.on('media-server-error', (data) => {
            console.error('❌ Media server error:', data.error);
            alert('Media server is not ready. Please try again in a moment.');
            document.getElementById('startBtn').disabled = false;
            document.getElementById('startBtn').textContent = this.isScreenPage ? 'Join Screen Share' : 'Join Conference';
        });

        this.socket.on('room-status', (data) => {
            this.updateRoomStatus(data);
        });

        this.socket.on('user-video-toggled', (data) => {
            console.log(`📹 User ${data.socketId} video toggled: ${data.enabled}`);
            this.updateUserMediaStatus(data.socketId, 'video', data.enabled);
        });

        this.socket.on('user-audio-toggled', (data) => {
            console.log(`🎤 User ${data.socketId} audio toggled: ${data.enabled}`);
            this.updateUserMediaStatus(data.socketId, 'audio', data.enabled);
        });

        this.socket.on('init', (data) => {
            console.log('🎯 Received init data for user index:', data.userIndex, 'page type:', data.pageType);
            this.myUserIndex = data.userIndex;
            this.pageType = data.pageType;
            this.isScreenPage = this.pageType === 'screen';
            
            this.updateLocalUserIndex(this.myUserIndex);
            this.updateUIForPageType();

            data.currentUsers.forEach(user => {
                this.addUser(user.socketId, user.name, user.userIndex, user.videoEnabled, user.audioEnabled);
            });

            data.currentProducers.forEach(producer => {
                if (producer.isScreen) {
                    this.pendingPresentations.push(producer);
                } else {
                    this.pendingProducers.push(producer);
                }
            });

            console.log(`📦 Buffered ${this.pendingProducers.length} producers and ${this.pendingPresentations.length} presentations`);

            // ДОБАВЛЯЕМ: Добавляем кнопки после инициализации
            setTimeout(() => {
                this.addFullscreenButtonsToExistingElements();
            }, 500);
        });

        this.socket.on('user-joined', (data) => {
            this.addUser(data.socketId, data.name, data.userIndex, data.videoEnabled, data.audioEnabled);
        });

        this.socket.on('user-updated', (data) => {
            this.updateUser(data.socketId, data.name, data.userIndex, data.videoEnabled, data.audioEnabled);
        });

        this.socket.on('user-left', (data) => {
            this.removeUser(data.socketId);
        });

        this.socket.on('new-producer', async (data) => {
            console.log('📹 Received new-producer event from:', data.peerName);
            if (!this.deviceReady) {
                console.log('📦 Buffering producer until device is ready');
                this.pendingProducers.push(data);
                return;
            }
            await this.consumeUserProducer(data);
        });

        this.socket.on('new-presentation', async (data) => {
            console.log('🖥️ Received new-presentation event from:', data.peerName);
            if (!this.deviceReady) {
                console.log('📦 Buffering presentation until device is ready');
                this.pendingPresentations.push(data);
                return;
            }
            await this.consumePresentation(data);
        });

        this.socket.on('presentation-ended', (data) => {
            console.log('📺 Received presentation-ended event:', data);
            this.removePresentation(data.producerId);
        });
    }

    // ОБНОВЛЯЕМ ФУНКЦИЮ: Добавляем вызов при получении новых пользователей
    addUser(socketId, name, userIndex, videoEnabled = true, audioEnabled = true) {
        if (socketId === this.socket.id) return;

        this.userStates.set(socketId, { name, userIndex, videoEnabled, audioEnabled });
        console.log(`👤 User joined: ${name} (scr${userIndex})`);

        // Добавляем кнопки после короткой задержки (чтобы DOM успел обновиться)
        setTimeout(() => {
            this.addFullscreenButtonsToExistingElements();
        }, 100);

        if (this.videoSwitcher.style.display === 'block') {
            this.updateVideoSwitcherList();
        }

        this.updateRoomStatus();
    }

    updateUserMediaStatus(socketId, mediaType, enabled) {
        const userElement = document.getElementById(`user-${socketId}`);
        if (!userElement) {
            console.warn(`User element not found for ${socketId}`);
            return;
        }

        const userState = this.userStates.get(socketId);
        if (userState) {
            if (mediaType === 'video') {
                userState.videoEnabled = enabled;
            } else if (mediaType === 'audio') {
                userState.audioEnabled = enabled;
            }
        }

        const videoIndicator = userElement.querySelector('.status-video-active, .status-video-muted');
        const audioIndicator = userElement.querySelector('.status-audio-active, .status-audio-muted');

        if (videoIndicator && mediaType === 'video') {
            videoIndicator.className = `status-indicator status-video-${enabled ? 'active' : 'muted'}`;
            videoIndicator.textContent = enabled ? '📹' : '🚫';
        }

        if (audioIndicator && mediaType === 'audio') {
            audioIndicator.className = `status-indicator status-audio-${enabled ? 'active' : 'muted'}`;
            audioIndicator.textContent = enabled ? '🎤' : '🚫';
        }

        console.log(`✅ Updated ${mediaType} status for ${socketId}: ${enabled ? 'enabled' : 'disabled'}`);

        if (this.videoSwitcher.style.display === 'block') {
            this.updateVideoSwitcherList();
        }
    }

    async processPendingProducers() {
        if (this.pendingProducers.length === 0 && this.pendingPresentations.length === 0) {
            return;
        }

        console.log(`🔄 Processing ${this.pendingProducers.length} pending producers and ${this.pendingPresentations.length} pending presentations`);

        for (const producer of this.pendingProducers) {
            try {
                await this.consumeUserProducer(producer);
            } catch (error) {
                console.error(`❌ Failed to process pending producer ${producer.id}:`, error);
            }
        }

        for (const presentation of this.pendingPresentations) {
            try {
                await this.consumePresentation(presentation);
            } catch (error) {
                console.error(`❌ Failed to process pending presentation ${presentation.id}:`, error);
            }
        }

        this.pendingProducers = [];
        this.pendingPresentations = [];

        console.log("✅ All pending producers processed");
    }

    updateLocalUserIndex(userIndex) {
        this.myUserIndex = userIndex;
        const localIndexElement = document.querySelector('.self .screen-number');
        if (localIndexElement) {
            localIndexElement.textContent = `scr${userIndex}`;
        }
        console.log(`📝 Updated local user index to: scr${userIndex}`);
    }

    updateUser(socketId, name, userIndex, videoEnabled, audioEnabled) {
        const user = this.userStates.get(socketId);
        if (user) {
            user.name = name;
            user.userIndex = userIndex;
            user.videoEnabled = videoEnabled;
            user.audioEnabled = audioEnabled;

            const userElement = document.getElementById(`user-${socketId}`);
            if (userElement) {
                const titleEl = userElement.querySelector('.video-title');
                if (titleEl) titleEl.textContent = name;

                const indexEl = userElement.querySelector('.screen-number');
                if (indexEl) indexEl.textContent = `scr${userIndex}`;

                const videoIndicator = userElement.querySelector('.status-video-active, .status-video-muted');
                const audioIndicator = userElement.querySelector('.status-audio-active, .status-audio-muted');

                if (videoIndicator) {
                    videoIndicator.className = `status-indicator status-video-${videoEnabled ? 'active' : 'muted'}`;
                    videoIndicator.textContent = videoEnabled ? '📹' : '🚫';
                }

                if (audioIndicator) {
                    audioIndicator.className = `status-indicator status-audio-${audioEnabled ? 'active' : 'muted'}`;
                    audioIndicator.textContent = audioEnabled ? '🎤' : '🚫';
                }
            }
        }

        if (this.videoSwitcher.style.display === 'block') {
            this.updateVideoSwitcherList();
        }
    }

    removeUser(socketId) {
        if (this.swapSource && this.swapSource.id === `user-${socketId}`) {
            this.cancelSwap();
        }
        if (this.swapTarget && this.swapTarget.id === `user-${socketId}`) {
            this.cancelSwap();
        }

        const userVideo = document.getElementById(`user-${socketId}`);
        if (userVideo) userVideo.remove();

        this.removeUserPresentations(socketId);

        this.consumers.forEach((consumerData, producerId) => {
            if (consumerData.socketId === socketId) {
                try {
                    consumerData.consumer.close();
                    if (consumerData.transport) {
                        consumerData.transport.close();
                    }
                } catch (error) {
                    console.error(`Error closing consumer for ${socketId}:`, error);
                }
                this.consumers.delete(producerId);
            }
        });

        this.userStates.delete(socketId);

        if (this.videoSwitcher.style.display === 'block') {
            this.updateVideoSwitcherList();
        }

        this.updateRoomStatus();

        console.log(`🗑️ User left: ${socketId}`);
    }

    async consumeUserProducer(data) {
        await this.consumeProducer(data, false);
    }

    // ОБНОВЛЯЕМ ФУНКЦИЮ: Добавляем вызов при получении новых демонстраций
    async consumePresentation(data) {
        await this.consumeProducer(data, true);
        
        // Добавляем кнопки после создания элемента
        setTimeout(() => {
            this.addFullscreenButtonsToExistingElements();
        }, 100);
    }

    async consumeProducer(data, isPresentation) {
        const { id: producerId, socketId, kind, peerName, userIndex, presentationIndex } = data;

        if (socketId === this.socket.id && !isPresentation) {
            console.log(`⏭️ Skipping consumption of own producer ${producerId}`);
            return;
        }

        if (this.consumers.has(producerId)) {
            console.log(`⏭️ Already consuming producer ${producerId}, skipping`);
            return;
        }

        console.log(`🔄 Starting to consume ${isPresentation ? 'presentation' : 'user'} ${kind} from ${peerName}`);

        try {
            const transportData = await this.fetchJSON(`${CONFIG.URL_PREFIX}/create-transport`, {
                method: 'POST',
                body: JSON.stringify({
                    socketId: this.socket.id,
                    direction: 'recv',
                    roomType: this.pageType
                })
            });

            const consumerTransport = this.device.createRecvTransport(transportData);
            this.consumerTransports.set(consumerTransport.id, consumerTransport);

            consumerTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
                try {
                    console.log(`🔗 Connecting consumer transport for ${producerId}...`);
                    await this.fetchJSON(`${CONFIG.URL_PREFIX}/connect-transport`, {
                        method: 'POST',
                        body: JSON.stringify({
                            transportId: consumerTransport.id,
                            dtlsParameters,
                            roomType: this.pageType
                        })
                    });
                    console.log(`✅ Consumer transport connected for ${producerId}`);
                    callback();
                } catch (error) {
                    console.error(`❌ Consumer transport connection failed for ${producerId}:`, error);
                    errback(error);
                }
            });

            consumerTransport.on('connectionstatechange', (state) => {
                console.log(`🔗 Consumer transport for ${producerId} state: ${state}`);
            });

            console.log(`📡 Consuming producer ${producerId}...`);
            const consumerData = await this.fetchJSON(`${CONFIG.URL_PREFIX}/consume`, {
                method: 'POST',
                body: JSON.stringify({
                    transportId: consumerTransport.id,
                    producerId,
                    rtpCapabilities: this.device.rtpCapabilities,
                    roomType: this.pageType
                })
            });

            const consumer = await consumerTransport.consume(consumerData);

            this.consumers.set(producerId, {
                consumer,
                transport: consumerTransport,
                socketId,
                kind,
                isPresentation
            });

            if (isPresentation) {
                this.presentations.set(producerId, {
                    socketId,
                    peerName,
                    presentationIndex
                });

                this.createPresentationElement(producerId, consumer, kind, peerName, presentationIndex);

                if (this.videoSwitcher.style.display === 'block') {
                    this.updateVideoSwitcherList();
                }
            } else {
                if (!this.userStates.has(socketId)) {
                    this.userStates.set(socketId, { name: peerName, userIndex, videoEnabled: true, audioEnabled: true });
                }

                this.createUserElement(socketId, consumer, kind, peerName, userIndex);
            }

            console.log(`✅ Successfully consumed ${isPresentation ? 'presentation' : 'user'} ${kind} from ${peerName}`);

        } catch (error) {
            console.error(`❌ Error consuming ${kind} from ${socketId}:`, error);
        }
    }

    // ОБНОВЛЯЕМ ФУНКЦИЮ: Упрощаем создание элементов (убираем дублирование кнопок)
    createUserElement(socketId, consumer, kind, peerName, userIndex) {
        const elementId = `user-${socketId}`;
        let mediaElement = document.getElementById(elementId);

        const userState = this.userStates.get(socketId);
        const videoEnabled = userState ? userState.videoEnabled : true;
        const audioEnabled = userState ? userState.audioEnabled : true;

        if (!mediaElement) {
            mediaElement = document.createElement('div');
            mediaElement.className = 'video-wrapper peer';
            mediaElement.id = elementId;

            // УБИРАЕМ кнопку из HTML - будем добавлять отдельно
            mediaElement.innerHTML = `
                <div class="video-header">
                    <div class="video-title">${peerName}</div>
                </div>
                <div class="screen-number">scr${userIndex}</div>
                <div class="status-indicators">
                    <div class="status-indicator status-video-${videoEnabled ? 'active' : 'muted'}">
                        ${videoEnabled ? '📹' : '🚫'}
                    </div>
                    <div class="status-indicator status-audio-${audioEnabled ? 'active' : 'muted'}">
                        ${audioEnabled ? '🎤' : '🚫'}
                    </div>
                </div>
                <video autoplay playsinline class="user-video"></video>
                <audio autoplay></audio>
            `;

            document.getElementById('peersContainer').appendChild(mediaElement);
            console.log(`🎨 Created user element for ${peerName} with ID: ${elementId}`);
        }

        this.setupMediaElement(mediaElement, consumer, kind);
        
        // ДОБАВЛЯЕМ кнопку отдельно
        setTimeout(() => {
            this.addFullscreenButtonsToExistingElements();
        }, 100);
    }

    // ОБНОВЛЯЕМ ФУНКЦИЮ: Аналогично для демонстраций экрана
    createPresentationElement(producerId, consumer, kind, peerName, presentationIndex) {
        const elementId = `presentation-${producerId}`;
        let mediaElement = document.getElementById(elementId);

        if (!mediaElement) {
            mediaElement = document.createElement('div');
            mediaElement.className = 'video-wrapper screen-share';
            mediaElement.id = elementId;

            const isOwn = this.socket && this.socket.id === consumer.socketId;
            const title = isOwn ? 'Your Screen Share' : `${peerName}'s Screen`;

            // УБИРАЕМ кнопку из HTML - будем добавлять отдельно
            mediaElement.innerHTML = `
                <div class="video-header">
                    <div class="video-title">${title}</div>
                </div>
                <div class="screen-number">pr${presentationIndex}</div>
                <video autoplay playsinline class="presentation-video"></video>
                <audio autoplay></audio>
            `;

            const presentationsContainer = document.getElementById('presentationsContainer') || this.createPresentationsContainer();
            presentationsContainer.appendChild(mediaElement);

            document.getElementById('presentationsSection').style.display = 'block';

            console.log(`🎨 Created presentation element for ${peerName} with ID: ${elementId} (pr${presentationIndex})`);
        }

        this.setupMediaElement(mediaElement, consumer, kind);
        
        // ДОБАВЛЯЕМ кнопку отдельно
        setTimeout(() => {
            this.addFullscreenButtonsToExistingElements();
        }, 100);
    }

    setupMediaElement(mediaElement, consumer, kind) {
        const video = mediaElement.querySelector('video');
        const audio = mediaElement.querySelector('audio');

        try {
            if (kind === 'video') {
                const stream = new MediaStream([consumer.track]);
                if (video) {
                    video.srcObject = stream;
                    video.onloadedmetadata = () => {
                        video.play().catch(e => console.warn('Video play failed:', e));
                    };
                }
            } else if (kind === 'audio') {
                const stream = new MediaStream([consumer.track]);
                if (audio) {
                    audio.srcObject = stream;
                    audio.play().catch(e => console.warn('Audio play failed:', e));
                }
            }
        } catch (error) {
            console.error('Error setting up media element:', error);
        }
    }

    removePresentation(producerId) {
        if (this.swapSource && this.swapSource.id === `presentation-${producerId}`) {
            this.cancelSwap();
        }
        if (this.swapTarget && this.swapTarget.id === `presentation-${producerId}`) {
            this.cancelSwap();
        }

        const presentationElement = document.getElementById(`presentation-${producerId}`);
        if (presentationElement) {
            presentationElement.remove();
        }

        const consumerData = this.consumers.get(producerId);
        if (consumerData) {
            try {
                consumerData.consumer.close();
                if (consumerData.transport) {
                    consumerData.transport.close();
                }
            } catch (error) {
                console.error(`Error closing presentation consumer ${producerId}:`, error);
            }
            this.consumers.delete(producerId);
        }

        this.presentations.delete(producerId);
        this.activeScreenProducers.delete(producerId);

        if (this.videoSwitcher.style.display === 'block') {
            this.updateVideoSwitcherList();
        }

        this.updateRoomStatus();

        const presentationsContainer = document.getElementById('presentationsContainer');
        if (presentationsContainer && presentationsContainer.children.length === 0) {
            document.getElementById('presentationsSection').style.display = 'none';
        }

        console.log(`🗑️ Presentation ended: ${producerId}`);
    }

    removeUserPresentations(socketId) {
        this.presentations.forEach((presentation, producerId) => {
            if (presentation.socketId === socketId) {
                this.removePresentation(producerId);
            }
        });
    }

    createPresentationsContainer() {
        const presentationsSection = document.createElement('div');
        presentationsSection.id = 'presentationsSection';
        presentationsSection.className = 'presentations-section';
        presentationsSection.style.display = 'none';

        presentationsSection.innerHTML = `
            <div class="section-separator">
                <div class="separator-line"></div>
                <div class="separator-text">Screen Shares</div>
                <div class="separator-line"></div>
            </div>
            <div class="video-grid presentations-grid" id="presentationsContainer">
                <!-- Presentations will be added here dynamically -->
            </div>
        `;

        const peersContainer = document.getElementById('peersContainer');
        peersContainer.parentNode.insertBefore(presentationsSection, peersContainer.nextSibling);

        return document.getElementById('presentationsContainer');
    }

    handleDisconnect() {
        this.consumers.forEach((consumerData, producerId) => {
            try {
                consumerData.consumer.close();
                if (consumerData.transport) {
                    consumerData.transport.close();
                }
            } catch (error) {
                console.error('Error during disconnect cleanup:', error);
            }
        });

        this.producers.forEach((producer, key) => {
            try {
                producer.close();
            } catch (error) {
                console.error('Error closing producer:', error);
            }
        });

        if (this.producerTransport) {
            try {
                this.producerTransport.close();
            } catch (error) {
                console.error('Error closing producer transport:', error);
            }
        }

        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
        }

        if (this.screenStream) {
            this.screenStream.getTracks().forEach(track => track.stop());
        }

        this.consumers.clear();
        this.consumerTransports.clear();
        this.producers.clear();
        this.userStates.clear();
        this.presentations.clear();
        this.activeScreenProducers.clear();
        this.pendingProducers = [];
        this.pendingPresentations = [];

        this.isStarted = false;
        this.deviceReady = false;
        this.device = null;
        this.producerTransport = null;
        this.localStream = null;
        this.screenStream = null;
        this.currentMainVideo = null;
        this.isSwapMode = false;
        this.swapSource = null;
        this.swapTarget = null;

        document.getElementById('startBtn').disabled = false;
        document.getElementById('startBtn').textContent = this.isScreenPage ? 'Join Screen Share' : 'Join Conference';
        document.getElementById('mediaControls').style.display = 'none';

        const peersContainer = document.getElementById('peersContainer');
        while (peersContainer.children.length > 1) {
            peersContainer.removeChild(peersContainer.lastChild);
        }

        const presentationsSection = document.getElementById('presentationsSection');
        if (presentationsSection) {
            presentationsSection.remove();
        }

        this.hideVideoSwitcher();
        this.hideSwapInstructions();
        this.clearSwapHighlights();
        this.disableSwapModeVisuals();

        console.log("🔄 Client reset after disconnect");
    }

    async toggleScreenShare() {
        try {
            if (this.isSharingScreen) {
                console.log("🔄 Stopping screen share...");
                this.stopScreenShare();
            } else {
                console.log("🔄 Starting screen share...");
                await this.startScreenShare();
            }

            if (this.videoSwitcher.style.display === 'block') {
                this.updateVideoSwitcherList();
            }
        } catch (error) {
            console.error('Error toggling screen share:', error);
            this.isSharingScreen = false;
            if (error.name !== 'NotAllowedError') {
                alert('Error sharing screen: ' + error.message);
            }
        }
    }

    async startScreenShare() {
        this.isSharingScreen = true;

        this.screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                cursor: 'always',
                displaySurface: 'window'
            },
            audio: true
        });

        console.log("🖥️ Got screen stream, producing tracks...");

        await this.produceScreenTracks();

        document.getElementById('screenShareBtn').textContent = '📷 Stop Share';

        this.screenStream.getVideoTracks()[0].onended = () => {
            console.log("🖥️ Screen share ended by browser");
            this.toggleScreenShare();
        };

        console.log('🔄 Started screen share');
    }

    stopScreenShare() {
        this.socket.emit('stop-screen-share');

        if (this.screenStream) {
            this.screenStream.getTracks().forEach(track => track.stop());
            this.screenStream = null;
        }

        this.producers.forEach((producer, key) => {
            if (key.includes('screen')) {
                try {
                    producer.close();
                } catch (error) {
                    console.error(`Error closing screen producer ${key}:`, error);
                }
                this.producers.delete(key);
            }
        });

        this.activeScreenProducers.clear();
        this.isSharingScreen = false;
        document.getElementById('screenShareBtn').textContent = '📺 Share Screen';

        console.log('🔄 Stopped screen share');
    }

    toggleVideo() {
        this.videoEnabled = !this.videoEnabled;

        if (this.localStream) {
            const videoTrack = this.localStream.getVideoTracks()[0];
            if (videoTrack) videoTrack.enabled = this.videoEnabled;
        }

        const btn = document.getElementById('toggleVideoBtn');
        btn.textContent = this.videoEnabled ? '📹 Video On' : '🚫 Video Off';
        btn.classList.toggle('active', this.videoEnabled);

        this.socket.emit('toggle-video', { enabled: this.videoEnabled });
    }

    toggleAudio() {
        this.audioEnabled = !this.audioEnabled;

        if (this.localStream) {
            const audioTrack = this.localStream.getAudioTracks()[0];
            if (audioTrack) audioTrack.enabled = this.audioEnabled;
        }

        const btn = document.getElementById('toggleAudioBtn');
        btn.textContent = this.audioEnabled ? '🎤 Audio On' : '🚫 Audio Off';
        btn.classList.toggle('active', this.audioEnabled);

        this.socket.emit('toggle-audio', { enabled: this.audioEnabled });
    }

    updateRoomStatus(data) {
        let userCount, presentationCount;

        if (data) {
            userCount = data.userCount;
            presentationCount = data.screenShareCount;
        } else {
            userCount = this.userStates.size + (this.isStarted ? 1 : 0);
            presentationCount = this.presentations.size;
        }

        const roomStatus = document.getElementById('roomStatus');
        const screenCount = document.getElementById('screenCount');
        const peerCount = document.getElementById('peerCount');

        if (roomStatus) roomStatus.textContent = `Users: ${userCount}/${CONFIG.MAX_USERS} | Presentations: ${presentationCount}/${CONFIG.MAX_SCREEN_SHARES}`;
        if (screenCount) screenCount.textContent = presentationCount;
        if (peerCount) peerCount.textContent = userCount;

        console.log(`📊 Room status updated: ${userCount} users, ${presentationCount} presentations`);
    }

    async fetchJSON(url, options = {}) {
        try {
            const res = await fetch(url, {
                headers: { 'Content-Type': 'application/json' },
                ...options
            });

            if (!res.ok) {
                const errorText = await res.text();
                
                if (res.status === 503) {
                    throw new Error('Media server is not ready. Please refresh the page and try again.');
                }
                
                throw new Error(`HTTP ${res.status}: ${errorText}`);
            }

            return res.json();
        } catch (error) {
            console.error(`❌ Fetch error for ${url}:`, error);
            
            if (error.message.includes('Media server is not ready')) {
                alert('Media server is starting up. Please wait a moment and try again.');
            }
            
            throw error;
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.conference = new VideoConference();
});
