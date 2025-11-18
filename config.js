const path = require('path');

// Load environment variables
require('dotenv').config();

const config = {
  // Server
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  
  // Room limits
  maxUsers: parseInt(process.env.MAX_USERS) || 3,
  maxScreenShares: parseInt(process.env.MAX_SCREEN_SHARES) || 2,
  
  // Page configuration - NEW
  availablePages: ['webcam1', 'webcam2', 'webcam3', 'screen'],
  maxPages: 4,
  
  // URL configuration
  urlPrefix: process.env.URL_PREFIX || '/zzy',
  socketPath: process.env.SOCKET_PATH || '/zzy/socket.io',
  
  // Network configuration
  announcedIp: process.env.ANNOUNCED_IP || '146.103.125.231',
  listenIp: process.env.LISTEN_IP || '0.0.0.0',
  
  // Media configuration
  initialOutgoingBitrate: parseInt(process.env.INITIAL_OUTGOING_BITRATE) || 1000000,
  
  // Derived paths
  get publicPath() {
    return path.join(__dirname, 'public');
  },
  
  // Page-specific configurations - NEW
  pageConfigs: {
    webcam1: {
      title: "Webcam Page 1",
      description: "Video conference with camera and audio",
      icon: "📹",
      defaultName: "User1",
      media: {
        requestVideo: true,
        requestAudio: true
      }
    },
    webcam2: {
      title: "Webcam Page 2", 
      description: "Video conference with camera and audio",
      icon: "📹",
      defaultName: "User2",
      media: {
        requestVideo: true,
        requestAudio: true
      }
    },
    webcam3: {
      title: "Webcam Page 3",
      description: "Video conference with camera and audio", 
      icon: "📹",
      defaultName: "User3",
      media: {
        requestVideo: true,
        requestAudio: true
      }
    },
    screen: {
      title: "Screen Share Page",
      description: "Share your screen and presentations",
      icon: "🖥️", 
      defaultName: "Presenter",
      media: {
        requestVideo: false,
        requestAudio: true
      }
    }
  },
  
  // Media codecs (static configuration)
  mediaCodecs: [
    {
      kind: "audio",
      mimeType: "audio/opus",
      clockRate: 48000,
      channels: 2,
      parameters: {
        minptime: 10,
        useinbandfec: 1
      }
    },
    {
      kind: "video", 
      mimeType: "video/VP8",
      clockRate: 90000,
    },
    {
      kind: "video",
      mimeType: "video/H264",
      clockRate: 90000,
      parameters: {
        'packetization-mode': 1,
        'profile-level-id': '42e01f'
      }
    }
  ]
};

// Helper methods - NEW
config.getPageConfig = function(pageType) {
  return this.pageConfigs[pageType] || this.pageConfigs.webcam1;
};

config.isValidPageType = function(pageType) {
  return this.availablePages.includes(pageType);
};

config.getAvailablePages = function() {
  return this.availablePages;
};

// Validate required environment variables
const required = ['ANNOUNCED_IP'];
required.forEach(key => {
  if (!process.env[key]) {
    console.warn(`⚠️  Warning: ${key} environment variable is not set`);
  }
});

// Log configuration on startup
console.log('🔧 Server Configuration:');
console.log(`   Port: ${config.port}`);
console.log(`   Environment: ${config.nodeEnv}`);
console.log(`   Max Users: ${config.maxUsers}`);
console.log(`   Max Screen Shares: ${config.maxScreenShares}`);
console.log(`   Available Pages: ${config.availablePages.join(', ')}`);
console.log(`   URL Prefix: ${config.urlPrefix}`);
console.log(`   Announced IP: ${config.announcedIp}`);

module.exports = config;