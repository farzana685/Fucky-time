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

app.get('/ping', (req, res) => res.status(200).send('OK - FUNKY STUDIO 24/7 LIVE'));

const MONGO_URI = process.env.MONGO_URI || 'YOUR_MONGODB_URI';
const OWNER_ID = process.env.OWNER_ID || 'owner_admin';
const OWNER_PASS = process.env.OWNER_PASS || 'OwnerSecret@2026';

mongoose.connect(MONGO_URI)
  .then(() => console.log('MongoDB Connected Successfully'))
  .catch(err => console.error('DB Error:', err));

const userSchema = new mongoose.Schema({
  userId: { type: String, unique: true, required: true },
  passwordHash: { type: String, required: true },
  points: { type: Number, default: 0, min: 0 },
  totalDeposited: { type: Number, default: 0 },
  requiredTurnover: { type: Number, default: 0 },
  completedTurnover: { type: Number, default: 0 },
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

const houseStatsSchema = new mongoose.Schema({
  key: { type: String, default: 'MAIN_HOUSE', unique: true },
  totalHouseProfit: { type: Number, default: 0 },
  totalBetsCollected: { type: Number, default: 0 },
  totalPayoutsGiven: { type: Number, default: 0 }
});
const HouseStats = mongoose.model('HouseStats', houseStatsSchema);

const PAYOUTS = {
  '1': 2, 'P': 25, 'L': 25, 'A': 25, 'Y': 25,
  'F': 25, 'U': 25, 'N': 25, 'K': 25, 'T': 25,
  'I': 25, 'M': 25, 'E': 25, 'BAR': 7, 'DISCO': 15,
  'STAYIN': 40, 'VIP': 100
};

const WHEEL_64 = [
  '1','VIP','1','1','1','1','F','U','N','K','1','BAR','1','1','1','1',
  'STAYIN','1','1','1','1','T','I','M','E','1','BAR','1','1','1','1',
  'DISCO','1','1','1','1','P','L','A','Y','1','BAR','1','1','1','1',
  'F','U','N','K','1','DISCO','1','1','1','1','STAYIN','1','1','BAR',
  'T','I','M','E'
].slice(0, 64);

let onlineSockets = {};
let currentBets = {};
let gameState = 'BETTING';
let timer = 10;
let currentRotation = 0;
let lastResult = null;
let recentResults = ['1', 'BAR', 'P', '1', 'DISCO', '1', 'F', '1', 'T', '1'];
let consecutiveLossRounds = 0;

async function getSortedUsersForOwner() {
  const activeUserSet = new Set(Object.values(onlineSockets));
  const rawUsers = await User.find({}, 'userId points totalWon totalLost requiredTurnover completedTurnover').sort({ points: -1 }).lean();
  return rawUsers
    .map(u => ({ ...u, isOnline: activeUserSet.has(u.userId) }))
    .sort((a, b) => (Number(b.isOnline) - Number(a.isOnline)) || (b.points - a.points));
}

async function broadcastOwnerUsers() {
  const pending = await PointRequest.find({ status: 'PENDING' }).sort({ createdAt: -1 });
  const allUsers = await getSortedUsersForOwner();
  io.to('OWNER_ROOM').emit('refresh_owner_data', { pending, allUsers });
}
async function calculateSpinResult() {
  const weights = {
    '1': 38.0, 'P': 2.8, 'L': 2.8, 'A': 2.8, 'Y': 2.8,
    'F': 2.8, 'U': 2.8, 'N': 2.8, 'K': 2.8, 'T': 2.8,
    'I': 2.8, 'M': 2.8, 'E': 2.8, 'BAR': 12.0, 'DISCO': 5.8,
    'STAYIN': 2.0, 'VIP': 0.8
  };

  let totalRoundBet = 0;
  const segmentBetTotals = {};
  const activeUserIds = Object.keys(currentBets);

  for (let uId of activeUserIds) {
    for (let seg in currentBets[uId]) {
      const amt = currentBets[uId][seg];
      totalRoundBet += amt;
      segmentBetTotals[seg] = (segmentBetTotals[seg] || 0) + amt;
    }
  }

  if (totalRoundBet > 0) {
    const stats = await HouseStats.findOne({ key: 'MAIN_HOUSE' });
    const prevBets = stats ? stats.totalBetsCollected : 0;
    const prevPayouts = stats ? stats.totalPayoutsGiven : 0;

    const players = await User.find({ userId: { $in: activeUserIds } });
    let isPlayerInExcitementZone = false;
    for (let p of players) {
      const baseDeposit = p.totalDeposited > 0 ? p.totalDeposited : 200;
      const excitementTarget = baseDeposit * 2.3;
      if (p.points < excitementTarget) {
        isPlayerInExcitementZone = true;
        break;
      }
    }

    const initialHouseSafetyFund = 2500;
    const cumulativeBets = prevBets + totalRoundBet;
    const maxCumulativePayoutAllowed = (cumulativeBets * 0.80) + initialHouseSafetyFund;
    const strictRemainingBudget = Math.max(totalRoundBet * 0.80, maxCumulativePayoutAllowed - prevPayouts);

    const safeSegments = Object.keys(PAYOUTS).filter(seg => {
      const potentialPayout = (segmentBetTotals[seg] || 0) * PAYOUTS[seg];
      return potentialPayout <= strictRemainingBudget;
    });

    if ((consecutiveLossRounds >= 2 || (isPlayerInExcitementZone && Math.random() < 0.52)) && safeSegments.length > 0) {
      const winningOptions = safeSegments.filter(seg => (segmentBetTotals[seg] || 0) > 0);
      if (winningOptions.length > 0) {
        const mediumWins = winningOptions.filter(seg => PAYOUTS[seg] >= 2 && PAYOUTS[seg] <= 25);
        if (mediumWins.length > 0 && Math.random() < 0.70) {
          return mediumWins[Math.floor(Math.random() * mediumWins.length)];
        }
        return winningOptions[Math.floor(Math.random() * winningOptions.length)];
      }
    }

    if (safeSegments.length > 0) {
      const totalSafeWeight = safeSegments.reduce((acc, k) => acc + (weights[k] || 1), 0);
      let rand = Math.random() * totalSafeWeight;
      for (let key of safeSegments) {
        if (rand < (weights[key] || 1)) return key;
        rand -= (weights[key] || 1);
      }
      return safeSegments[0];
    }
  }

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

    const winnerId = await calculateSpinResult();
    const matchingIndices = WHEEL_64.map((v, i) => (v === winnerId ? i : -1)).filter(i => i !== -1);
    const targetIndex = matchingIndices[Math.floor(Math.random() * matchingIndices.length)];
    const sliceAngle = 360 / 64;
    const randomOffset = (Math.random() * 0.5 + 0.25) * sliceAngle;
    const targetAngle = 360 - (targetIndex * sliceAngle) - randomOffset;

    currentRotation += (360 * 10) + ((targetAngle - (currentRotation % 360) + 360) % 360);
    io.emit('spin_start', { rotation: currentRotation, duration: 15 });

  } else if (gameState === 'SPINNING' && timer <= 0) {
    gameState = 'RESULT';
    timer = 5;

    const sliceAngle = 360 / 64;
    const normalizedAngle = (360 - (currentRotation % 360)) % 360;
    const landedIndex = Math.floor(normalizedAngle / sliceAngle) % 64;
    const winnerId = WHEEL_64[landedIndex];
    const multiplier = PAYOUTS[winnerId];

    recentResults.unshift(winnerId);
    if (recentResults.length > 10) recentResults.pop();

    let totalRoundBets = 0;
    let totalRoundPayouts = 0;

    for (let uId in currentBets) {
      const userBets = currentBets[uId];
      let roundUserBet = 0;
      let roundUserWin = 0;

      for (let seg in userBets) {
        roundUserBet += userBets[seg];
        if (seg === winnerId) {
          roundUserWin += userBets[seg] * multiplier;
        }
      }

      totalRoundBets += roundUserBet;
      totalRoundPayouts += roundUserWin;

      const netLoss = roundUserWin === 0 ? roundUserBet : 0;
      const updatedUser = await User.findOneAndUpdate(
        { userId: uId },
        {
          $inc: {
            points: roundUserWin,
            totalWon: roundUserWin,
            totalLost: netLoss
          }
        },
        { new: true }
      );

      if (updatedUser) {
        if (updatedUser.points < 10 && updatedUser.requiredTurnover > updatedUser.completedTurnover) {
          updatedUser.requiredTurnover = 0;
          updatedUser.completedTurnover = 0;
          await updatedUser.save();
        }
        const remTurnover = Math.max(0, (updatedUser.requiredTurnover || 0) - (updatedUser.completedTurnover || 0));
        io.to(uId).emit('points_updated', {
          points: updatedUser.points,
          totalWon: updatedUser.totalWon,
          totalLost: updatedUser.totalLost,
          remainingTurnover: remTurnover,
          lastWin: roundUserWin
        });
      }
    }

    if (totalRoundBets > 0) {
      if (totalRoundPayouts === 0) {
        consecutiveLossRounds++;
      } else {
        consecutiveLossRounds = 0;
      }

      const roundProfit = totalRoundBets - totalRoundPayouts;
      const houseStats = await HouseStats.findOneAndUpdate(
        { key: 'MAIN_HOUSE' },
        {
          $inc: {
            totalHouseProfit: roundProfit,
            totalBetsCollected: totalRoundBets,
            totalPayoutsGiven: totalRoundPayouts
          }
        },
        { upsert: true, new: true }
      );
      io.to('OWNER_ROOM').emit('house_stats_updated', houseStats);
      await broadcastOwnerUsers();
    }

    currentBets = {};
    lastResult = { winner: winnerId, payout: multiplier };
    io.emit('round_result', { ...lastResult, recentResults });

  } else if (gameState === 'RESULT' && timer <= 0) {
    gameState = 'BETTING';
    timer = 10;
    io.emit('betting_start', { timer: 10 });
  }

  io.emit('timer_update', { state: gameState, timer: timer });
}, 1000);
io.on('connection', (socket) => {
  socket.emit('wheel_setup', {
    wheel: WHEEL_64,
    payouts: PAYOUTS,
    state: gameState,
    timer: timer,
    rotation: currentRotation,
    lastResult: lastResult,
    recentResults: recentResults
  });

  socket.on('register_user', async ({ userId, password }) => {
    try {
      if (typeof userId !== 'string' || typeof password !== 'string') return;
      const cleanId = userId.trim().toLowerCase();

      if (cleanId === OWNER_ID.toLowerCase()) {
        return socket.emit('auth_error', 'এই আইডিটি সংরক্ষিত! অন্য নম্বর দিন।');
      }

      const bdPhoneRegex = /^01[3-9]\d{8}$/;
      if (!bdPhoneRegex.test(cleanId)) {
        return socket.emit('auth_error', 'সঠিক ১১ ডিজিটের বাংলাদেশি মোবাইল নম্বর দিন (যেমন: 017xxxxxxxx)!');
      }

      if (password.length < 4) {
        return socket.emit('auth_error', 'পাসওয়ার্ড কমপক্ষে ৪ অক্ষরের দিন।');
      }

      const existing = await User.findOne({ userId: cleanId });
      if (existing) return socket.emit('auth_error', 'এই মোবাইল নম্বর দিয়ে আগেই অ্যাকাউন্ট খোলা হয়েছে!');

      const hash = await bcrypt.hash(password, 10);
      const newUser = await User.create({
        userId: cleanId,
        passwordHash: hash,
        points: 200,
        requiredTurnover: 300
      });

      await PointRequest.create({
        userId: cleanId,
        type: 'BONUS',
        amount: 200,
        note: 'নতুন অ্যাকাউন্ট ওয়েলকাম বোনাস (২০০ TK)',
        status: 'APPROVED'
      });

      const history = await PointRequest.find({ userId: cleanId }).sort({ createdAt: -1 }).limit(20);

      socket.join(cleanId);
      onlineSockets[socket.id] = cleanId;
      await broadcastOwnerUsers();

      socket.emit('auth_success', {
        userId: newUser.userId,
        points: newUser.points,
        totalWon: 0,
        totalLost: 0,
        remainingTurnover: 300,
        role: 'player',
        history
      });
    } catch (e) {
      socket.emit('auth_error', 'রেজিস্ট্রেশন সমস্যা হয়েছে!');
    }
  });

  socket.on('login_user', async ({ userId, password }) => {
    try {
      if (typeof userId !== 'string' || typeof password !== 'string') return;
      const cleanId = userId.trim().toLowerCase();

      if (cleanId === OWNER_ID.toLowerCase()) {
        if (password !== OWNER_PASS) {
          return socket.emit('auth_error', 'ভুল পাসওয়ার্ড! শুধুমাত্র ওনার প্রবেশ করতে পারবেন।');
        }
        socket.join('OWNER_ROOM');
        onlineSockets[socket.id] = 'OWNER';
        const pending = await PointRequest.find({ status: 'PENDING' }).sort({ createdAt: -1 });
        const allUsers = await getSortedUsersForOwner();
        const houseStats = await HouseStats.findOneAndUpdate(
          { key: 'MAIN_HOUSE' },
          {},
          { upsert: true, new: true }
        );
        return socket.emit('auth_success', {
          userId: OWNER_ID,
          points: 999999,
          role: 'owner',
          pendingRequests: pending,
          allUsers,
          houseStats
        });
      }

      const user = await User.findOne({ userId: cleanId });
      if (!user) return socket.emit('auth_error', 'এই মোবাইল নম্বরটি খুঁজে পাওয়া যায়নি!');

      const isMatch = await bcrypt.compare(password, user.passwordHash);
      if (!isMatch) return socket.emit('auth_error', 'ভুল পাসওয়ার্ড!');

      const history = await PointRequest.find({ userId: cleanId }).sort({ createdAt: -1 }).limit(20);
      const remTurnover = Math.max(0, (user.requiredTurnover || 0) - (user.completedTurnover || 0));
      socket.join(cleanId);
      onlineSockets[socket.id] = cleanId;
      await broadcastOwnerUsers();

      socket.emit('auth_success', {
        userId: user.userId,
        points: user.points,
        totalWon: user.totalWon,
        totalLost: user.totalLost,
        remainingTurnover: remTurnover,
        role: 'player',
        history
      });
    } catch (e) {
      socket.emit('auth_error', 'লগইন ব্যর্থ হয়েছে!');
    }
  });

  socket.on('place_bet', async ({ segmentId, amount }) => {
    const uId = onlineSockets[socket.id];
    const betAmount = Math.floor(Number(amount));

    if (!uId || uId === 'OWNER' || gameState !== 'BETTING') return;
    if (!PAYOUTS[segmentId] || isNaN(betAmount) || betAmount <= 0) return;

    const user = await User.findOneAndUpdate(
      { userId: uId, points: { $gte: betAmount } },
      { $inc: { points: -betAmount, completedTurnover: betAmount } },
      { new: true }
    );

    if (!user) return socket.emit('bet_error', 'পর্যাপ্ত ব্যালেন্স নেই! অনুগ্রহ করে Deposit রিকোয়েস্ট পাঠান।');

    if (!currentBets[uId]) currentBets[uId] = {};
    currentBets[uId][segmentId] = (currentBets[uId][segmentId] || 0) + betAmount;

    const remTurnover = Math.max(0, (user.requiredTurnover || 0) - (user.completedTurnover || 0));
    socket.emit('points_updated', {
      points: user.points,
      totalWon: user.totalWon,
      totalLost: user.totalLost,
      remainingTurnover: remTurnover
    });

    socket.emit('my_bets_updated', currentBets[uId]);
  });

  socket.on('remove_bet', async ({ segmentId }) => {
    const uId = onlineSockets[socket.id];
    if (!uId || uId === 'OWNER' || gameState !== 'BETTING') return;
    if (!currentBets[uId] || !currentBets[uId][segmentId]) return;

    const refundAmount = currentBets[uId][segmentId];
    delete currentBets[uId][segmentId];

    const user = await User.findOneAndUpdate(
      { userId: uId },
      { $inc: { points: refundAmount, completedTurnover: -refundAmount } },
      { new: true }
    );

    if (user) {
      if (user.completedTurnover < 0) {
        user.completedTurnover = 0;
        await user.save();
      }
      const remTurnover = Math.max(0, (user.requiredTurnover || 0) - (user.completedTurnover || 0));
      socket.emit('points_updated', {
        points: user.points,
        totalWon: user.totalWon,
        totalLost: user.totalLost,
        remainingTurnover: remTurnover
      });
    }
    socket.emit('my_bets_updated', currentBets[uId]);
  });

  socket.on('clear_bets', async () => {
    const uId = onlineSockets[socket.id];
    if (!uId || uId === 'OWNER' || gameState !== 'BETTING') return;
    if (!currentBets[uId]) return;

    let totalRefund = 0;
    for (let seg in currentBets[uId]) {
      totalRefund += currentBets[uId][seg];
    }
    if (totalRefund <= 0) return;

    currentBets[uId] = {};

    const user = await User.findOneAndUpdate(
      { userId: uId },
      { $inc: { points: totalRefund, completedTurnover: -totalRefund } },
      { new: true }
    );

    if (user) {
      if (user.completedTurnover < 0) {
        user.completedTurnover = 0;
        await user.save();
      }
      const remTurnover = Math.max(0, (user.requiredTurnover || 0) - (user.completedTurnover || 0));
      socket.emit('points_updated', {
        points: user.points,
        totalWon: user.totalWon,
        totalLost: user.totalLost,
        remainingTurnover: remTurnover
      });
    }
    socket.emit('my_bets_updated', {});
  });
  socket.on('send_point_request', async ({ type, amount, note }) => {
    const uId = onlineSockets[socket.id];
    const numAmt = Math.floor(Number(amount));
    if (!uId || uId === 'OWNER' || isNaN(numAmt) || numAmt <= 0) return;
    if (type !== 'ADD' && type !== 'DEDUCT') return;

    if (type === 'DEDUCT') {
      const checkUser = await User.findOne({ userId: uId });
      if (!checkUser || checkUser.points < numAmt) {
        return socket.emit('bet_error', 'আপনার অ্যাকাউন্টে এত TK নেই!');
      }
      const remTurnover = Math.max(0, (checkUser.requiredTurnover || 0) - (checkUser.completedTurnover || 0));
      if (remTurnover > 0) {
        return socket.emit('bet_error', `উইথড্র করতে হলে আরও ${remTurnover} TK গেম খেলতে (Turnover) হবে!`);
      }

      const updatedUser = await User.findOneAndUpdate(
        { userId: uId, points: { $gte: numAmt } },
        { $inc: { points: -numAmt } },
        { new: true }
      );
      socket.emit('points_updated', {
        points: updatedUser.points,
        totalWon: updatedUser.totalWon,
        totalLost: updatedUser.totalLost,
        remainingTurnover: 0
      });
    }

    const finalNote = type === 'DEDUCT'
      ? `Withdraw Number: ${uId} | ${(note || '').toString().substring(0, 40)}`
      : (note || '').toString().substring(0, 60);

    const reqDoc = await PointRequest.create({
      userId: uId,
      type,
      amount: numAmt,
      note: finalNote
    });

    const history = await PointRequest.find({ userId: uId }).sort({ createdAt: -1 }).limit(20);
    socket.emit('history_updated', history);
    socket.emit('request_sent', 'রিকোয়েস্ট পাঠানো হয়েছে! ওনার অ্যাপ্রুভ করলে সাথে সাথে কনফার্ম হবে।');
    io.to('OWNER_ROOM').emit('new_owner_request', reqDoc);
  });

  socket.on('owner_give_bonus', async ({ targetUserId, amount }) => {
    if (onlineSockets[socket.id] !== 'OWNER') return;
    const bonusAmt = Math.floor(Number(amount));
    if (!targetUserId || isNaN(bonusAmt) || bonusAmt <= 0) return;

    const cleanTarget = targetUserId.trim().toLowerCase();
    const addedTurnover = Math.round(bonusAmt * 1.5);

    const updatedUser = await User.findOneAndUpdate(
      { userId: cleanTarget },
      { $inc: { points: bonusAmt, requiredTurnover: addedTurnover } },
      { new: true }
    );

    if (!updatedUser) {
      return socket.emit('owner_msg', 'এই মোবাইল নম্বরটি খুঁজে পাওয়া যায়নি!');
    }

    await PointRequest.create({
      userId: cleanTarget,
      type: 'BONUS',
      amount: bonusAmt,
      note: `অ্যাডমিন স্পেশাল বোনাস (${bonusAmt} TK)`,
      status: 'APPROVED'
    });

    const remTurnover = Math.max(0, (updatedUser.requiredTurnover || 0) - (updatedUser.completedTurnover || 0));
    io.to(cleanTarget).emit('points_updated', {
      points: updatedUser.points,
      totalWon: updatedUser.totalWon,
      totalLost: updatedUser.totalLost,
      remainingTurnover: remTurnover,
      bonusReceived: bonusAmt
    });

    const history = await PointRequest.find({ userId: cleanTarget }).sort({ createdAt: -1 }).limit(20);
    io.to(cleanTarget).emit('history_updated', history);

    await broadcastOwnerUsers();
    socket.emit('owner_msg', `${cleanTarget}-কে সফলভাবে ${bonusAmt} TK বোনাস দেওয়া হয়েছে!`);
  });

  socket.on('owner_handle_request', async ({ requestId, action }) => {
    if (onlineSockets[socket.id] !== 'OWNER') return;

    const reqDoc = await PointRequest.findById(requestId);
    if (!reqDoc || reqDoc.status !== 'PENDING') return;

    if (action === 'APPROVE') {
      if (reqDoc.type === 'ADD') {
        const addedTurnover = Math.round(reqDoc.amount * 1.5);
        const existingUser = await User.findOne({ userId: reqDoc.userId });
        const hasZeroBalance = !existingUser || existingUser.points < 10;

        const updateQuery = hasZeroBalance
          ? {
              $inc: { points: reqDoc.amount, totalDeposited: reqDoc.amount },
              $set: { requiredTurnover: addedTurnover, completedTurnover: 0 }
            }
          : {
              $inc: {
                points: reqDoc.amount,
                totalDeposited: reqDoc.amount,
                requiredTurnover: addedTurnover
              }
            };

        const updatedUser = await User.findOneAndUpdate(
          { userId: reqDoc.userId },
          updateQuery,
          { new: true }
        );
        reqDoc.status = 'APPROVED';
        await reqDoc.save();

        if (updatedUser) {
          const remTurnover = Math.max(0, (updatedUser.requiredTurnover || 0) - (updatedUser.completedTurnover || 0));
          io.to(reqDoc.userId).emit('points_updated', {
            points: updatedUser.points,
            totalWon: updatedUser.totalWon,
            totalLost: updatedUser.totalLost,
            remainingTurnover: remTurnover
          });
        }
      } else if (reqDoc.type === 'DEDUCT') {
        reqDoc.status = 'APPROVED';
        await reqDoc.save();
      }
    } else {
      if (reqDoc.type === 'DEDUCT') {
        const refundedUser = await User.findOneAndUpdate(
          { userId: reqDoc.userId },
          { $inc: { points: reqDoc.amount } },
          { new: true }
        );
        if (refundedUser) {
          const remTurnover = Math.max(0, (refundedUser.requiredTurnover || 0) - (refundedUser.completedTurnover || 0));
          io.to(reqDoc.userId).emit('points_updated', {
            points: refundedUser.points,
            totalWon: refundedUser.totalWon,
            totalLost: refundedUser.totalLost,
            remainingTurnover: remTurnover
          });
        }
      }
      reqDoc.status = 'REJECTED';
      await reqDoc.save();
    }

    const history = await PointRequest.find({ userId: reqDoc.userId }).sort({ createdAt: -1 }).limit(20);
    io.to(reqDoc.userId).emit('history_updated', history);
    await broadcastOwnerUsers();
  });

  socket.on('disconnect', async () => {
    delete onlineSockets[socket.id];
    await broadcastOwnerUsers();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Funky Studio Live 24/7 on ${PORT}`));
