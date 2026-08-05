const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const QRCode = require('qrcode');
const session = require('express-session');

const app = express();
const DATA_FILE = path.join(__dirname, 'data', 'jobsite_data.json');

require('dotenv').config();

// ==========================================
// MIDDLEWARE SETUP
// ==========================================

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
    res.locals.baseUrl = `${req.protocol}://${req.get('host')}`;
    res.locals.currentPath = req.path;
    res.locals.isAdmin = req.session && req.session.isAdmin === true;
    next();
});

// Session Configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret-key-change-this-in-production',
  resave: true,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 48, // 48 Hours
    httpOnly: true,
    // Set secure to true ONLY when running under HTTPS in production
    secure: process.env.NODE_ENV === 'production' && process.env.HTTPS === 'true',
    sameSite: 'lax'
  }
}));

// Global Session Interceptor: Ensures session is saved before any redirect occurs
app.use((req, res, next) => {
  const originalRedirect = res.redirect;
  res.redirect = function (url) {
    if (req.session) {
      req.session.save((err) => {
        if (err) console.error('Session save error during redirect:', err);
        originalRedirect.call(this, url);
      });
    } else {
      originalRedirect.call(this, url);
    }
  };
  next();
});

// ==========================================
// AUTHENTICATION MIDDLEWARE
// ==========================================

function requireAuth(req, res, next) {
  if (req.session && req.session.isAdmin === true) {
    return next();
  }

  // Handle AJAX / JSON authentication failures gracefully
  if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Redirect to login WITHOUT destroying the session store
  res.redirect('/admin/login');
}

// ==========================================
// HELPER FUNCTIONS
// ==========================================

function getData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      const dir = path.dirname(DATA_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const defaultData = { houses: [] };
      fs.writeFileSync(DATA_FILE, JSON.stringify(defaultData, null, 2));
      return defaultData;
    }
    const rawData = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(rawData);
    if (!parsed.houses) parsed.houses = [];
    return parsed;
  } catch (err) {
    console.error('Error reading data:', err);
    return { houses: [] };
  }
}

function saveData(data) {
  try {
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid data object');
    }
    if (!data.houses) data.houses = [];

    // Atomic file write using temporary file
    const tempFile = DATA_FILE + '.tmp';
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempFile, DATA_FILE);
    return true;
  } catch (err) {
    console.error('Error saving data:', err);
    throw err;
  }
}

function findRoomAndHouseById(data, roomId) {
  // Safety check: handle null, undefined, or non-string inputs
  if (!roomId || typeof roomId !== 'string') {
    return { room: null, house: null };
  }

  // Your existing search logic...
  for (const house of data.houses || []) {
    if (roomId.startsWith(house.id)) { // Now safe from crashing!
      const room = house.rooms.find(r => r.id === roomId);
      if (room) return { room, house };
    }
  }

  return { room: null, house: null };
}

function findRoomById(data, roomId) {
  const { room } = findRoomAndHouseById(data, roomId);
  return room;
}

function deleteFileFromDisk(webUrl) {
  if (!webUrl || typeof webUrl !== 'string') return;
  const relativePath = webUrl.startsWith('/') ? webUrl.substring(1) : webUrl;
  const filePath = path.join(__dirname, 'public', relativePath);

  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      console.error(`Failed to delete file from disk: ${filePath}`, err);
    }
  }
}

// ==========================================
// FILE UPLOAD CONFIGURATION
// ==========================================

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const data = getData(); // or load your json data

    // 1. Try req.params.id first, or parse it directly from req.url
    let roomId = req.params && (req.params.id || req.params.roomId);

    if (!roomId && req.url) {
      // Regex matches /admin/edit/:roomId/save or /admin/rooms/:roomId etc.
      const match = req.url.match(/\/(?:edit|rooms|room)\/([^\/]+)/);
      if (match) {
        roomId = match[1];
      }
    }

    // 2. Fetch house & room safely
    const { room, house } = findRoomAndHouseById(data, roomId);

    // 3. Fall back to generic paths if room or house isn't found
    const houseFolder = house ? house.id : 'default-house';
    const roomFolder = room ? room.id : (roomId || 'general');

    const dir = path.join(__dirname, 'public', 'uploads', houseFolder, roomFolder);

    // Create folder structure dynamically
    fs.mkdirSync(dir, { recursive: true });

    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 1024 * 1024 * 1024 // 1GB limit
  }
});

function getFileType(mimetype) {
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype === 'application/pdf') return 'pdf';
  if (mimetype.startsWith('application/') || mimetype.startsWith('text/')) return 'document';
  return 'other';
}

// ==========================================
// AUTH ROUTES (Unprotected)
// ==========================================

app.get('/admin/login', (req, res) => {
  if (req.session && req.session.isAdmin) {
    return res.redirect('/admin');
  }
  res.render('login', { error: null });
});

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;

  const ADMIN_USER = process.env.ADMIN_USER;
  const ADMIN_PASS = process.env.ADMIN_PASS;

  if (!ADMIN_USER || !ADMIN_PASS) {
    console.error('ERROR: ADMIN_USER or ADMIN_PASS not set in environment variables');
    return res.render('login', { error: 'System configuration error. Please contact administrator.' });
  }

  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.isAdmin = true;
    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
        return res.render('login', { error: 'Login failed. Please try again.' });
      }
      return res.redirect('/admin');
    });
  } else {
    return res.render('login', { error: 'Invalid username or password.' });
  }
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('Logout error:', err);
    }
    res.redirect('/admin/login');
  });
});

// ==========================================
// PROTECTED ADMIN ROUTE GATEKEEPER
// ==========================================

app.use('/admin', (req, res, next) => {
  if (req.path === '/login' || req.path === '/login/' || (req.method === 'POST' && req.path === '/login')) {
    return next();
  }
  requireAuth(req, res, next);
});

// 1. Admin Dashboard
app.get('/admin', (req, res) => {
  try {
    const data = getData();
    res.render('admin', { houses: data.houses || [] });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).send('Error loading dashboard');
  }
});

// 2. Create House
app.post('/admin/houses', (req, res) => {
  try {
    const data = getData();
    const houseName = req.body.houseName;
    const newHouse = {
      id: houseName.toLowerCase().trim().replace(/[^a-z0-9]/g, '-'),
      name: houseName,
      rooms: []
    };

    data.houses.push(newHouse);
    saveData(data);

    req.session.save((err) => {
      if (err) console.error('Session save error:', err);
      res.redirect('/admin');
    });
  } catch (err) {
    console.error('Error creating house:', err);
    res.status(500).send('Error creating house');
  }
});

// Rename House (Supports both standard form POST and AJAX)
app.post('/admin/houses/:houseId/rename', (req, res) => {
  try {
    const data = getData();
    const house = data.houses.find(h => h.id === req.params.houseId);

    if (house) {
      house.name = req.body.newName.trim();
      saveData(data);

      if (req.is('json') || req.xhr) {
        return res.json({ success: true, name: house.name });
      }

      req.session.save((err) => {
        if (err) console.error('Session save error:', err);
        res.redirect('/admin');
      });
    } else {
      res.status(404).send('House not found');
    }
  } catch (error) {
    console.error('Error renaming house:', error);
    res.status(500).send('Error renaming house');
  }
});

// Rename Room (Supports both standard form POST and AJAX)
app.post('/admin/rooms/:roomId/rename', (req, res) => {
  try {
    const data = getData();
    const room = findRoomById(data, req.params.roomId);

    if (room) {
      room.name = req.body.newName.trim();
      saveData(data);

      if (req.is('json') || req.xhr) {
        return res.json({ success: true, name: room.name });
      }

      req.session.save((err) => {
        if (err) console.error('Session save error:', err);
        res.redirect('/admin');
      });
    } else {
      res.status(404).send('Room not found');
    }
  } catch (error) {
    console.error('Error renaming room:', error);
    res.status(500).send('Error renaming room');
  }
});

// Delete Room
app.post('/admin/rooms/:roomId/delete', (req, res) => {
  try {
    const data = getData();
    const roomId = req.params.roomId;

    let roomFound = false;

    // Search through houses to find and remove the room
    data.houses.forEach((house) => {
      const initialLength = house.rooms.length;
      house.rooms = house.rooms.filter((room) => room.id !== roomId);

      if (house.rooms.length < initialLength) {
        roomFound = true;
      }
    });

    if (roomFound) {
      saveData(data);

      req.session.save((err) => {
        if (err) console.error('Session save error:', err);
        res.redirect('/admin');
      });
    } else {
      res.status(404).send('Room not found');
    }
  } catch (error) {
    console.error('Error deleting room:', error);
    res.status(500).send('Error deleting room');
  }
});

// Delete House
app.post('/admin/houses/:houseId/delete', (req, res) => {
  try {
    const data = getData();
    data.houses = data.houses.filter(h => h.id !== req.params.houseId);
    saveData(data);

    req.session.save((err) => {
      if (err) console.error('Session save error:', err);
      res.redirect('/admin');
    });
  } catch (err) {
    console.error('Error deleting house:', err);
    res.status(500).send('Error deleting house');
  }
});

// 3. Create Room
app.post('/admin/houses/:houseId/rooms', (req, res) => {
  try {
    const data = getData();
    const house = data.houses.find(h => h.id === req.params.houseId);

    if (house) {
      const roomName = req.body.roomName;
      const newRoom = {
        id: `${house.id}-${roomName.toLowerCase().trim().replace(/[^a-z0-9]/g, '-')}`,
        name: roomName,
        status: 'draft',
        trades: [
          { id: 'electrical', name: 'Electrical', renderUrl: '', planUrl: '', notes: '', files: [] },
          { id: 'plumbing', name: 'Plumbing', renderUrl: '', planUrl: '', notes: '', files: [] },
          { id: 'hvac', name: 'HVAC', renderUrl: '', planUrl: '', notes: '', files: [] }
        ],
        comments: []
      };
      if (!house.rooms) house.rooms = [];
      house.rooms.push(newRoom);
      saveData(data);

      req.session.save((err) => {
        if (err) console.error('Session save error:', err);
        res.redirect(`/admin/edit/${newRoom.id}`);
      });
    } else {
      res.status(404).send('House not found');
    }
  } catch (err) {
    console.error('Error creating room:', err);
    res.status(500).send('Error creating room');
  }
});

// 4. Edit Room Interface
app.get('/admin/edit/:id', (req, res) => {
  try {
    const data = getData();
    const room = findRoomById(data, req.params.id);

    if (!room) return res.status(404).send('Room not found');
    const selectedTrade = req.query.trade || (room.trades[0] ? room.trades[0].id : '');

    res.render('admin-edit', { room, selectedTrade });
  } catch (err) {
    console.error('Error loading edit page:', err);
    res.status(500).send('Error loading edit page');
  }
});

// Rename Trade Tab
app.post('/admin/edit/:roomId/rename-trade/:tradeId', (req, res) => {
  try {
    const data = getData();
    const { roomId, tradeId } = req.params;
    const { newName } = req.body;

    const room = findRoomById(data, roomId);
    if (room) {
      const trade = room.trades.find(t => t.id === tradeId);
      if (trade) {
        trade.name = newName.trim();
        saveData(data);

        // NEW: return JSON for AJAX callers instead of always redirecting
        if (req.is('json') || req.xhr) {
          return res.json({ success: true, name: trade.name });
        }

        req.session.save((err) => {
          if (err) console.error('Session save error:', err);
          res.redirect(`/admin/edit/${roomId}?trade=${tradeId}`);
        });
      } else {
        res.status(404).send('Trade not found');
      }
    } else {
      res.status(404).send('Room not found');
    }
  } catch (error) {
    console.error('Error renaming trade:', error);
    res.status(500).send('Error renaming trade');
  }
});

// 5. Save Room Trade Details
app.post('/admin/edit/:roomId/save', upload.fields([
  { name: 'render', maxCount: 1 },
  { name: 'plan', maxCount: 1 },
  { name: 'files', maxCount: 20 }
]), (req, res) => {
  try {
    const data = getData();
    const { roomId } = req.params;
    const { tradeId, notes } = req.body;

    const { room, house } = findRoomAndHouseById(data, roomId);
    if (!room) return res.status(404).send('Room not found');

    const trade = room.trades.find(t => t.id === tradeId);
    if (!trade) return res.status(404).send('Trade tab not found');

    trade.notes = notes || '';

    if (!trade.files) trade.files = [];

    const houseFolder = house ? house.id : 'unassigned';

    if (req.files) {
      if (req.files.render && req.files.render[0]) {
        if (trade.renderUrl) deleteFileFromDisk(trade.renderUrl);
        trade.renderUrl = `/uploads/${houseFolder}/${room.id}/${req.files.render[0].filename}`;
      }

      if (req.files.plan && req.files.plan[0]) {
        if (trade.planUrl) deleteFileFromDisk(trade.planUrl);
        trade.planUrl = `/uploads/${houseFolder}/${room.id}/${req.files.plan[0].filename}`;
      }

      if (req.files.files && req.files.files.length > 0) {
        req.files.files.forEach(file => {
          const fileUrl = `/uploads/${houseFolder}/${room.id}/${file.filename}`;
          trade.files.push({
            url: fileUrl,
            originalName: file.originalname,
            filename: file.filename,
            type: getFileType(file.mimetype),
            mimetype: file.mimetype,
            size: file.size,
            uploadedAt: new Date().toISOString()
          });
        });
      }
    }

    saveData(data);
    req.session.save((err) => {
      if (err) console.error('Session save error:', err);
      res.redirect(`/admin/edit/${roomId}?trade=${tradeId}`);
    });
  } catch (err) {
    console.error('Error saving trade:', err);
    res.status(500).send('Error saving trade details');
  }
});

// 6. Add Trade Tab
app.post('/admin/edit/:roomId/add-trade', (req, res) => {
  try {
    const data = getData();
    const { roomId } = req.params;
    const { tradeName } = req.body;

    const room = findRoomById(data, roomId);
    if (room) {
      const tradeId = tradeName.toLowerCase().trim().replace(/[^a-z0-9]/g, '-');
      const existingTrade = room.trades.find(t => t.id === tradeId);

      if (!existingTrade) {
        room.trades.push({
          id: tradeId,
          name: tradeName,
          renderUrl: '',
          planUrl: '',
          notes: '',
          files: []
        });
        saveData(data);
      }

      req.session.save((err) => {
        if (err) console.error('Session save error:', err);
        res.redirect(`/admin/edit/${roomId}?trade=${tradeId}`);
      });
    } else {
      res.status(404).send('Room not found');
    }
  } catch (err) {
    console.error('Error adding trade:', err);
    res.status(500).send('Error adding trade');
  }
});

// 7. Delete Trade Tab
app.post('/admin/edit/:roomId/delete-trade/:tradeId', (req, res) => {
  try {
    const data = getData();
    const room = findRoomById(data, req.params.roomId);

    if (room) {
      const tradeToDelete = room.trades.find(t => t.id === req.params.tradeId);
      if (tradeToDelete) {
        if (tradeToDelete.renderUrl) deleteFileFromDisk(tradeToDelete.renderUrl);
        if (tradeToDelete.planUrl) deleteFileFromDisk(tradeToDelete.planUrl);

        if (tradeToDelete.files && tradeToDelete.files.length > 0) {
          tradeToDelete.files.forEach(file => {
            deleteFileFromDisk(file.url);
          });
        }
      }

      room.trades = room.trades.filter(t => t.id !== req.params.tradeId);
      saveData(data);

      req.session.save((err) => {
        if (err) console.error('Session save error:', err);
        res.redirect(`/admin/edit/${room.id}`);
      });
    } else {
      res.status(404).send('Room not found');
    }
  } catch (err) {
    console.error('Error deleting trade:', err);
    res.status(500).send('Error deleting trade');
  }
});

app.get('/download/:roomId/:tradeId/:filename', (req, res) => {
  try {
    const data = getData();
    const room = findRoomById(data, req.params.roomId);
    if (!room) return res.status(404).send('Room not found');

    const trade = room.trades.find(t => t.id === req.params.tradeId);
    if (!trade || !trade.files) return res.status(404).send('File not found');

    const file = trade.files.find(f => f.filename === req.params.filename);
    if (!file) return res.status(404).send('File not found');

    const filePath = path.join(__dirname, 'public', file.url);
    if (fs.existsSync(filePath)) {
      res.download(filePath, file.originalName);
    } else {
      res.status(404).send('File not found on server');
    }
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).send('Error downloading file');
  }
});

app.post('/admin/edit/:roomId/delete-file/:tradeId/:fileIndex', (req, res) => {
  try {
    const data = getData();
    const { roomId, tradeId, fileIndex } = req.params;

    // 1. Find Room
    const room = findRoomById(data, roomId);
    if (!room) return res.status(404).send('Room not found');

    // 2. Find Trade (Converting both to String prevents strict type mismatches)
    const trade = room.trades ? room.trades.find(t => String(t.id) === String(tradeId)) : null;
    if (!trade) return res.status(404).send('Trade not found');

    // 3. Parse and Validate File Index
    const index = parseInt(fileIndex, 10);
    if (isNaN(index) || !Array.isArray(trade.files) || index < 0 || index >= trade.files.length) {
      return res.status(404).send('File not found');
    }

    // 4. Remove file from disk
    const fileToDelete = trade.files[index];
    if (fileToDelete && fileToDelete.url) {
      deleteFileFromDisk(fileToDelete.url);
    }

    // 5. Remove file entry from array
    trade.files.splice(index, 1);

    // 6. Save data and redirect
    saveData(data);
    req.session.save((err) => {
      if (err) console.error('Session save error:', err);
      res.redirect(`/admin/edit/${roomId}?trade=${tradeId}`);
    });
  } catch (err) {
    console.error('Error deleting file:', err);
    res.status(500).send('Error deleting file');
  }
});

app.post('/admin/edit/:roomId/delete-all-files/:tradeId', (req, res) => {
  try {
    const data = getData();
    const { roomId, tradeId } = req.params;

    const room = findRoomById(data, roomId);
    if (!room) return res.status(404).send('Room not found');

    const trade = room.trades.find(t => t.id === tradeId);
    if (!trade) return res.status(404).send('Trade not found');

    if (trade.files && trade.files.length > 0) {
      trade.files.forEach(file => {
        deleteFileFromDisk(file.url);
      });
      trade.files = [];
      saveData(data);
    }

    req.session.save((err) => {
      if (err) console.error('Session save error:', err);
      res.redirect(`/admin/edit/${roomId}?trade=${tradeId}`);
    });
  } catch (err) {
    console.error('Error deleting all files:', err);
    res.status(500).send('Error deleting files');
  }
});

// 8. Toggle Room Publish / Draft Status
app.post('/admin/toggle-publish/:id', (req, res) => {
  try {
    const data = getData();
    const room = findRoomById(data, req.params.id);

    if (room) {
      room.status = room.status === 'published' ? 'draft' : 'published';
      saveData(data);
    }

    req.session.save((err) => {
      if (err) console.error('Session save error:', err);
      res.redirect(`/admin/edit/${req.params.id}`);
    });
  } catch (err) {
    console.error('Error toggling publish status:', err);
    res.status(500).send('Error toggling publish status');
  }
});

// ==========================================
// PUBLIC VIEW ROUTES (Unprotected)
// ==========================================

app.get('/house/:id', (req, res) => {
  try {
    const data = getData();
    const house = data.houses.find(h => h.id === req.params.id);

    if (!house) return res.status(404).send('House project not found');

    res.render('house', { house, rooms: house.rooms || [] });
  } catch (err) {
    console.error('House view error:', err);
    res.status(500).send('Error loading house');
  }
});

app.get('/room/:id', async (req, res) => {
  try {
    const data = getData();
    const { room, house } = findRoomAndHouseById(data, req.params.id);

    if (!room) return res.status(404).send('Room specifications not found');

    const roomUrl = `${req.protocol}://${req.get('host')}/room/${room.id}`;
    const qrCodeUrl = await QRCode.toDataURL(roomUrl);
    const activeTrade = req.query.trade || (room.trades[0] ? room.trades[0].id : '');

    res.render('room', {
      room,
      house: house || null,
      activeTrade,
      qrCodeUrl,
      roomUrl
    });
  } catch (err) {
    console.error('Room view error:', err);
    res.status(500).send('Error loading room');
  }
});

app.post('/room/:id/comment', upload.array('attachments', 10), (req, res) => {
  try {
    const data = getData();
    const { room, house } = findRoomAndHouseById(data, req.params.id);

    if (!room) return res.status(404).send('Room not found');

    const houseFolder = house ? house.id : 'unassigned';
    const attachments = [];

    // Process uploaded attachments (if any)
    if (req.files && req.files.length > 0) {
      req.files.forEach(file => {
        const fileUrl = `/uploads/${houseFolder}/${room.id}/${file.filename}`;
        attachments.push({
          url: fileUrl,
          originalName: file.originalname,
          filename: file.filename,
          type: file.mimetype, // Saved as raw mimetype (e.g. image/jpeg, application/pdf)
          size: file.size
        });
      });
    }

    const newComment = {
      id: Date.now().toString(), // Adding an ID makes deleting/managing comments easier later
      author: req.body.author || 'Anonymous Trade',
      text: req.body.text,
      timestamp: new Date().toISOString().replace('T', ' ').substring(0, 16),
      attachments: attachments
    };

    if (!room.comments) room.comments = [];
    room.comments.unshift(newComment);

    saveData(data);

    // Maintain trade tab selection upon redirect
    const activeTrade = req.body.activeTrade || '';
    res.redirect(`/room/${req.params.id}${activeTrade ? `?trade=${activeTrade}` : ''}`);
  } catch (err) {
    console.error('Comment submission error:', err);
    res.status(500).send('Error adding comment');
  }
});

// Admin endpoint to delete a comment and clean up its files from disk
app.post('/admin/rooms/:roomId/comments/:commentIndex/delete', (req, res) => {
  try {
    const data = getData();
    const { roomId, commentIndex } = req.params;
    const room = findRoomById(data, roomId);

    if (!room || !room.comments) return res.status(404).send('Comment or room not found');

    const index = parseInt(commentIndex, 10);
    if (isNaN(index) || index < 0 || index >= room.comments.length) {
      return res.status(404).send('Invalid comment index');
    }

    // 1. Remove associated files from disk
    const commentToDelete = room.comments[index];
    if (commentToDelete.attachments && commentToDelete.attachments.length > 0) {
      commentToDelete.attachments.forEach(file => {
        deleteFileFromDisk(file.url);
      });
    }

    // 2. Remove comment from JSON data
    room.comments.splice(index, 1);
    saveData(data);

    req.session.save((err) => {
      if (err) console.error('Session save error:', err);
      res.redirect(`/admin/edit/${roomId}`);
    });
  } catch (err) {
    console.error('Error deleting comment:', err);
    res.status(500).send('Error deleting comment');
  }
});
// DELETE COMMENT ROUTE
app.post('/admin/edit/:roomId/delete-comment/:tradeId/:commentId', (req, res) => {
  const { roomId, tradeId, commentId } = req.params;
  const data = getData(); // Your function/variable that reads the JSON store

  const { room } = findRoomAndHouseById(data, roomId);

  if (room && room.trades) {
    const trade = room.trades.find(t => t.id === tradeId);
    if (trade && trade.comments) {
      // Filter out the comment by ID
      trade.comments = trade.comments.filter(c => String(c.id) !== String(commentId));
      saveData(data); // Your function to persist data back to JSON file
    }
  }

  // Redirect back to the admin edit page with the active trade tab
  res.redirect(`/admin/edit/${roomId}?trade=${tradeId}`);
});

app.post('/admin/edit/:roomId/delete-comment/:commentId', (req, res) => {
  const { roomId, commentId } = req.params;
  const data = getData();

  const { room } = findRoomAndHouseById(data, roomId);

  if (room && room.comments) {
    // Filter out the comment by ID
    room.comments = room.comments.filter(c => String(c.id) !== String(commentId));
    saveData(data);
  }

  // Preserve the selected trade tab if present in query/referrer
  const selectedTrade = req.query.trade || '';
  res.redirect(`/admin/edit/${roomId}${selectedTrade ? '?trade=' + selectedTrade : ''}`);
});

// POST COMMENT ROUTE (Client side)
app.post('/room/:roomId/comment', (req, res) => {
  const { roomId } = req.params;
  const { tradeId, text, author } = req.body;
  const data = getData();

  const { room } = findRoomAndHouseById(data, roomId);

  if (room) {
    const trade = room.trades.find(t => t.id === tradeId);
    if (trade) {
      // Initialize comments array if missing
      if (!trade.comments) {
        trade.comments = [];
      }

      // Add formatted comment object
      trade.comments.push({
        id: Date.now().toString(), // Unique ID for deletion
        author: author || 'Client',
        text: text,
        createdAt: new Date().toISOString()
      });

      saveData(data);
    }
  }

  res.redirect(`/room/${roomId}?trade=${tradeId}`);
});

app.get('/admin/edit/:roomId', (req, res) => {
  const { roomId } = req.params;
  const data = getData();
  const { room } = findRoomAndHouseById(data, roomId);

  if (!room) return res.status(404).send('Room not found');

  // Ensure default structure for older data
  room.trades.forEach(t => {
    if (!t.comments) t.comments = [];
    if (!t.files) t.files = [];
  });

  const selectedTrade = req.query.trade || (room.trades[0] ? room.trades[0].id : null);

  res.render('admin-edit-room', {
    room,
    selectedTrade
  });
});
// 404 Handler
app.use((req, res) => {
  res.status(404).render('404');
});

// Unhandled Errors Handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).send('Internal server error');
});

// ==========================================
// START SERVER
// ==========================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Admin panel running: http://localhost:${PORT}/admin`);
});