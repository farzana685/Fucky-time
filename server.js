const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const MONGO_URI = process.env.MONGO_URI || 'YOUR_MONGODB_URI';
const OWNER_ID = process.env.OWNER_ID || 'owner_admin';
const OWNER_PASS = process.env.OWNER_PASS || 'OwnerSecret@2026';

mongoose.connect(MONGO_URI)
  .then(() => console.log('MongoDB Connected Successfully'))
  .catch(err => console.error('DB Error:', err));

const userSchema = new mongoose.Schema({
  userId: { type: String, unique: true, required: true },
  passwordHash: { type: String, required: true },
  points: { type: Number, default: 0 },
  totalWon: { type: Number, default: 0 },
  totalLost: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const requestSchema = new mongoose.Schema({
  userId: String,
  type: String,
  amount: Number,
  note: String,
  status: { type: String, default: 'PENDING' },
  createdAt: { type: Date, default: Date.now }
});
const PointRequest = mongoose.model('PointRequest', requestSchema);

const PAYOUTS = {
  '1': 2, 'P': 25, 'L': 25, 'A': 25, 'Y': 25,
  'F': 25, 'U': 25, 'N': 25, 'K': 25, 'T': 25,
  'I': 25, 'M': 25, 'E': 25, 'BAR': 7, 'DISCO': 15,
  'STAYIN': 40, 'VIP': 100
};

const WHEEL_64 = [
  '1','P','1','L','1','BAR','1','A','1','Y','1','DISCO','1','F','1','U',
  '1','N','1','BAR','1','K','1','T','1','STAYIN','1','I','1','M','1','E',
  '1','P','1','BAR','1','L','1','A','1','DISCO','1','Y','1','F','1','U',
  '1','BAR','1','N','1','K','1','T','1','VIP','1','I','1','M','1','E',
  'BAR','DISCO','STAYIN','BAR'
].slice(0, 64);

let onlineSockets = {};
let currentBets = {};
let gameState = 'BETTING';
let timer = 5;
let currentRotation = 0;

function calculateSpinResult() {
  const weights = {
    '1': 40.0, 'P': 2.5, 'L': 2.5, 'A': 2.5, 'Y': 2.5,
    'F': 2.5, 'U': 2.5, 'N': 2.5, 'K': 2.5, 'T': 2.5,
    'I': 2.5, 'M': 2.5, 'E': 2.5, 'BAR': 11.4, 'DISCO': 5.3,
    'STAYIN': 2.0, 'VIP': 0.8
  };
  const keys = Object.keys(weights);
  const totalWeight = keys.reduce((acc, k) => acc + weights[k], 0);
  let rand = Math.random() * totalWeight;
  for (let key of keys) {
    if (rand < weights[key]) return key;
    rand -= weights[key];
  }
  return '1';
}

setInterval(async () => {
  timer--;

  if (gameState === 'BETTING' && timer <= 0) {
    gameState = 'SPINNING';
    timer = 15;

    const winnerId = calculateSpinResult();
    const matchingIndices = WHEEL_64.map((v, i) => (v === winnerId ? i : -1)).filter(i => i !== -1);
    const targetIndex = matchingIndices[Math.floor(Math.random() * matchingIndices.length)];
    const sliceAngle = 360 / 64;
    const targetAngle = 360 - (targetIndex * sliceAngle) - (sliceAngle / 2);

    currentRotation += (360 * 10) + ((targetAngle - (currentRotation % 360) + 360) % 360);
    io.emit('spin_start', { rotation: currentRotation, duration: 15 });

    setTimeout(async () => {
      const multiplier = PAYOUTS[winnerId];
      for (let uId in currentBets) {
        const userBets = currentBets[uId];
        let roundTotalBet = 0;
        let roundWin = 0;

        for (let seg in userBets) {
          roundTotalBet += userBets[seg];
          if (seg === winnerId) {
            roundWin += userBets[seg] * multiplier;
          }
        }

        const netLoss = roundWin === 0 ? roundTotalBet : 0;
        const updatedUser = await User.findOneAndUpdate(
          { userId: uId },
          {
            $inc: {
              points: roundWin,
              totalWon: roundWin,
              totalLost: netLoss
            }
          },
          { new: true }
        );

        if (updatedUser) {
          io.to(uId).emit('points_updated', {
            points: updatedUser.points,
            totalWon: updatedUser.totalWon,
            totalLost: updatedUser.totalLost
          });
        }
      }
      currentBets = {};
      io.emit('round_result', { winner: winnerId, payout: multiplier });
    }, 14800);

  } else if (gameState === 'SPINNING' && timer <= 0) {
    gameState = 'BETTING';
    timer = 5;
    io.emit('betting_start', { timer: 5 });
  }

  io.emit('timer_update', { state: gameState, timer: timer });
}, 1000);
io.on('connection', (socket) => {
  socket.emit('wheel_setup', { wheel: WHEEL_64, payouts: PAYOUTS, state: gameState, timer });

  socket.on('register_user', async ({ userId, password }) => {
    try {
      const cleanId = userId.trim().toLowerCase();
      if (cleanId.length < 3 || password.length < 4) {
        return socket.emit('auth_error', 'আইডি কমপক্ষে ৩ অক্ষর এবং পাসওয়ার্ড ৪ অক্ষরের দিন।');
      }
      if (cleanId === OWNER_ID.toLowerCase()) {
        return socket.emit('auth_error', 'এই আইডিটি সংরক্ষিত!');
      }
      const existing = await User.findOne({ userId: cleanId });
      if (existing) return socket.emit('auth_error', 'এই আইডি আগেই নেওয়া হয়েছে!');

      const hash = await bcrypt.hash(password, 10);
      const newUser = await User.create({ userId: cleanId, passwordHash: hash, points: 0 });

      socket.join(cleanId);
      onlineSockets[socket.id] = cleanId;
      socket.emit('auth_success', {
        userId: newUser.userId,
        points: 0,
        totalWon: 0,
        totalLost: 0,
        role: 'player',
        history: []
      });
    } catch (e) {
      socket.emit('auth_error', 'রেজিস্ট্রেশন সমস্যা হয়েছে।');
    }
  });

  socket.on('login_user', async ({ userId, password }) => {
    try {
      const cleanId = userId.trim().toLowerCase();

      if (cleanId === OWNER_ID.toLowerCase() && password === OWNER_PASS) {
        socket.join('OWNER_ROOM');
        onlineSockets[socket.id] = 'OWNER';
        const pending = await PointRequest.find({ status: 'PENDING' }).sort({ createdAt: -1 });
        const allUsers = await User.find({}, 'userId points totalWon totalLost').sort({ points: -1 });
        return socket.emit('auth_success', {
          userId: OWNER_ID,
          points: 999999,
          role: 'owner',
          pendingRequests: pending,
          allUsers
        });
      }

      const user = await User.findOne({ userId: cleanId });
      if (!user) return socket.emit('auth_error', 'এই আইডিটি খুঁজে পাওয়া যায়নি!');

      const isMatch = await bcrypt.compare(password, user.passwordHash);
      if (!isMatch) return socket.emit('auth_error', 'ভুল পাসওয়ার্ড!');

      const history = await PointRequest.find({ userId: cleanId }).sort({ createdAt: -1 }).limit(20);
      socket.join(cleanId);
      onlineSockets[socket.id] = cleanId;
      socket.emit('auth_success', {
        userId: user.userId,
        points: user.points,
        totalWon: user.totalWon,
        totalLost: user.totalLost,
        role: 'player',
        history
      });
    } catch (e) {
      socket.emit('auth_error', 'লগইন ব্যর্থ হয়েছে।');
    }
  });

  socket.on('place_bet', async ({ segmentId, amount }) => {
    const uId = onlineSockets[socket.id];
    if (!uId || uId === 'OWNER' || gameState !== 'BETTING' || amount <= 0) return;

    const user = await User.findOneAndUpdate(
      { userId: uId, points: { $gte: amount } },
      { $inc: { points: -amount } },
      { new: true }
    );

    if (!user) return socket.emit('bet_error', 'পর্যাপ্ত পয়েন্ট নেই! ওনারকে রিকোয়েস্ট পাঠান।');

    if (!currentBets[uId]) currentBets[uId] = {};
    currentBets[uId][segmentId] = (currentBets[uId][segmentId] || 0) + amount;

    socket.emit('points_updated', {
      points: user.points,
      totalWon: user.totalWon,
      totalLost: user.totalLost
    });
    socket.emit('my_bets_updated', currentBets[uId]);
  });

  socket.on('send_point_request', async ({ type, amount, note }) => {
    const uId = onlineSockets[socket.id];
    const numAmt = Number(amount);
    if (!uId || uId === 'OWNER' || numAmt <= 0) return;

    if (type === 'DEDUCT') {
      const user = await User.findOne({ userId: uId });
      if (!user || user.points < numAmt) {
        return socket.emit('bet_error', 'আপনার আইডিতে এত পয়েন্ট নেই!');
      }
    }

    const reqDoc = await PointRequest.create({
      userId: uId,
      type,
      amount: numAmt,
      note: (note || '').substring(0, 50)
    });

    const history = await PointRequest.find({ userId: uId }).sort({ createdAt: -1 }).limit(20);
    socket.emit('history_updated', history);
    socket.emit('request_sent', 'রিকোয়েস্ট পাঠানো হয়েছে! ওনার অ্যাপ্রুভ করলে সাথে সাথে আপডেট হবে।');
    io.to('OWNER_ROOM').emit('new_owner_request', reqDoc);
  });

  socket.on('owner_handle_request', async ({ requestId, action }) => {
    if (onlineSockets[socket.id] !== 'OWNER') return;

    const reqDoc = await PointRequest.findById(requestId);
    if (!reqDoc || reqDoc.status !== 'PENDING') return;

    if (action === 'APPROVE') {
      if (reqDoc.type === 'ADD') {
        const updatedUser = await User.findOneAndUpdate(
          { userId: reqDoc.userId },
          { $inc: { points: reqDoc.amount } },
          { new: true }
        );
        reqDoc.status = 'APPROVED';
        await reqDoc.save();

        if (updatedUser) {
          io.to(reqDoc.userId).emit('points_updated', {
            points: updatedUser.points,
            totalWon: updatedUser.totalWon,
            totalLost: updatedUser.totalLost
          });
        }
      } else if (reqDoc.type === 'DEDUCT') {
        const updatedUser = await User.findOneAndUpdate(
          { userId: reqDoc.userId, points: { $gte: reqDoc.amount } },
          { $inc: { points: -reqDoc.amount } },
          { new: true }
        );
        if (updatedUser) {
          reqDoc.status = 'APPROVED';
          await reqDoc.save();
          io.to(reqDoc.userId).emit('points_updated', {
            points: updatedUser.points,
            totalWon: updatedUser.totalWon,
            totalLost: updatedUser.totalLost
          });
        } else {
          reqDoc.status = 'REJECTED';
          await reqDoc.save();
        }
      }
    } else {
      reqDoc.status = 'REJECTED';
      await reqDoc.save();
    }

    const history = await PointRequest.find({ userId: reqDoc.userId }).sort({ createdAt: -1 }).limit(20);
    io.to(reqDoc.userId).emit('history_updated', history);

    const pending = await PointRequest.find({ status: 'PENDING' }).sort({ createdAt: -1 });
    const allUsers = await User.find({}, 'userId points totalWon totalLost').sort({ points: -1 });
    socket.emit('refresh_owner_data', { pending, allUsers });
  });

  socket.on('disconnect', () => {
    delete onlineSockets[socket.id];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Studio Server Live on ${PORT}`));
                                            
