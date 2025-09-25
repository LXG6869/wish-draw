// src/WishGameWithRooms.tsx
import { useState, useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import confetti from 'canvas-confetti';
import {
  Users,
  Heart,
  Shuffle,
  Plus,
  Minus,
  Check,
  Lock,
  Search,
  UserPlus,
  Copy,
  Home,
} from 'lucide-react';

// =====================
// 类型定义
// =====================
interface Player {
  id: string;
  name: string;
  wishes: string[];
  isOwner?: boolean;
  locked?: boolean; // 是否锁定愿望
  group?: string;   // ✅ 新增：分组（'A' | 'B' | 'C' | 'D'）
}

interface Wish {
  id: string;
  ownerId: string;
  text: string;
}

interface MatchPair {
  pickerId: string;
  wishId: string;
}

interface Room {
  id: string;
  password: string;
  ownerId: string;
  maxPlayers: number;
  players: Player[];
  stage: 'WAITING' | 'COLLECTING' | 'LOCK_CONFIRM' | 'MATCHING' | 'REVEALED' | 'FINISHED';
  wishes: Wish[];
  pairs: MatchPair[];
  seed: string;
  createdAt: number;
}

interface GameState {
  mode: 'MENU' | 'CREATE_ROOM' | 'JOIN_ROOM' | 'IN_ROOM';
  currentRoom?: Room;
  currentPlayerId?: string;
  showResults: boolean;
  isViewer?: boolean; // 只读查看
}

// =====================
// Mock API（内存房间管理）
// =====================
class MockRoomAPI {
  private rooms: Map<string, Room> = new Map();

  generateRoomId(): string {
    return Math.random().toString(36).substr(2, 6).toUpperCase();
  }

  private generateSeed(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  createRoom(password: string, maxPlayers: number, ownerId: string, ownerName: string): Room {
    const room: Room = {
      id: this.generateRoomId(),
      password,
      ownerId,
      maxPlayers,
      players: [],
      stage: 'WAITING',
      wishes: [],
      pairs: [],
      seed: this.generateSeed(),
      createdAt: Date.now()
    };

    // 把房主加入房间（默认 A 组）
    room.players.push({
      id: ownerId,
      name: ownerName || '房主',
      wishes: ['', ''],
      isOwner: true,
      locked: false,
      group: 'A', // ✅ 房主默认 A 组
    });

    this.rooms.set(room.id, room);
    return room;
  }

  joinRoom(
    roomId: string,
    password: string,
    playerId: string,
    playerName: string
  ): { success: boolean; error?: string; room?: Room; asViewer?: boolean; resolvedPlayerId?: string } {
    const room = this.rooms.get(roomId);

    if (!room) return { success: false, error: '房间不存在' };
    if (room.password !== password) return { success: false, error: '密码错误' };

    // 重连：按 id 或 名字
    const existingById = room.players.find(p => p.id === playerId);
    const sameNamePlayer = room.players.find(p => p.name === playerName);

    if (existingById) {
      return { success: true, room, asViewer: false, resolvedPlayerId: existingById.id };
    }
    if (sameNamePlayer) {
      return { success: true, room, asViewer: false, resolvedPlayerId: sameNamePlayer.id };
    }

    // 满员则只读
    if (room.players.length >= room.maxPlayers) {
      return { success: true, room, asViewer: true };
    }

    // ✅ 新增玩家：按“当前最少人数的组”自动分配（A-D）
    const groups = ['A', 'B', 'C', 'D'];
    const counts = groups.map(g => room.players.filter(p => p.group === g).length);
    const group = groups[counts.indexOf(Math.min(...counts))];

    room.players.push({
      id: playerId,
      name: playerName,
      wishes: ['', ''],
      isOwner: false,
      locked: false,
      group, // ✅ 自动分配的组
    });

    return { success: true, room, asViewer: false, resolvedPlayerId: playerId };
  }

  updateRoom(roomId: string, updater: (room: Room) => Room) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const updatedRoom = updater(room);
    this.rooms.set(roomId, updatedRoom);
    return updatedRoom;
  }

  getRoom(roomId: string) {
    return this.rooms.get(roomId) || null;
  }
}

const roomAPI = new MockRoomAPI();

// =====================
// 随机数 & 匹配算法（跨组约束）
// =====================
class SeededRandom {
  private seed: number;
  constructor(seed: string) {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      const char = seed.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    this.seed = Math.abs(hash);
  }
  next(): number {
    this.seed = (this.seed * 9301 + 49297) % 233280;
    return this.seed / 233280;
  }
  shuffle<T>(array: T[]): T[] {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
}

function matchWishes(players: Player[], wishes: Wish[], seed: string): MatchPair[] {
  const rng = new SeededRandom(seed);
  const shuffledWishes = rng.shuffle(wishes);
  const pairs: MatchPair[] = [];
  const usedWishes = new Set<string>();
  const groupOf = new Map(players.map(p => [p.id, p.group || 'A']));

  for (const player of players) {
    const myGroup = groupOf.get(player.id) || 'A';
    let assigned = false;

    for (const wish of shuffledWishes) {
      const ownerGroup = groupOf.get(wish.ownerId) || 'A';
      if (
        !usedWishes.has(wish.id) &&
        wish.ownerId !== player.id &&       // 不能抽到自己
        ownerGroup !== myGroup              // ✅ 不能抽到同组
      ) {
        pairs.push({ pickerId: player.id, wishId: wish.id });
        usedWishes.add(wish.id);
        assigned = true;
        break;
      }
    }

    if (!assigned) {
      throw new Error('当前分组下无法为所有玩家分配跨组愿望，请调整分组或增加参与者再试');
    }
  }

  return pairs;
}

// =====================
// 工具函数
// =====================
function sanitizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, 120);
}
function generatePlayerId(): string {
  return `player-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// =====================
// 主组件
// =====================
export default function WishGameWithRooms() {
  const [gameState, setGameState] = useState<GameState>({
    mode: 'MENU',
    showResults: false,
  });

  const [error, setError] = useState('');
  const [newPlayerName, setNewPlayerName] = useState('');
  const [editingPlayer, setEditingPlayer] = useState<string | null>(null);
  const [roomPassword, setRoomPassword] = useState('');
  const [joinRoomId, setJoinRoomId] = useState('');
  const [joinPassword, setJoinPassword] = useState('');
  const [maxPlayers, setMaxPlayers] = useState(6);
  const [showMatchFX, setShowMatchFX] = useState(false); // 匹配动画
  const mountedRef = useRef(true);

  // StrictMode 双挂载保护
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const updateGameState = (updater: (prev: GameState) => GameState) => {
    if (mountedRef.current) {
      setGameState(updater);
      setError('');
    }
  };
  const setErrorSafe = (msg: string) => mountedRef.current && setError(msg);

  // 房间管理
  const createRoom = () => {
    if (!roomPassword || roomPassword.length !== 4) {
      setErrorSafe('密码必须是4位数字或字母');
      return;
    }
    const playerId = generatePlayerId();
    const ownerName = newPlayerName ? sanitizeText(newPlayerName) : '房主';
    const room = roomAPI.createRoom(roomPassword, maxPlayers, playerId, ownerName);

    try { localStorage.setItem(`wishgame:${room.id}:${ownerName}`, playerId); } catch {}

    updateGameState(prev => ({
      ...prev,
      mode: 'IN_ROOM',
      currentRoom: room,
      currentPlayerId: playerId,
      isViewer: false,
    }));
  };

  const joinRoom = () => {
    if (!joinRoomId || !joinPassword || !newPlayerName) {
      setErrorSafe('请填写完整信息');
      return;
    }
    const roomId = joinRoomId.toUpperCase();
    const cleanName = sanitizeText(newPlayerName);

    let playerId = '';
    try { playerId = localStorage.getItem(`wishgame:${roomId}:${cleanName}`) || ''; } catch {}
    if (!playerId) playerId = generatePlayerId();

    const result = roomAPI.joinRoom(roomId, joinPassword, playerId, cleanName);

    if (result.success && result.room) {
      const resolvedId = result.resolvedPlayerId || (result.asViewer ? undefined : playerId);
      if (resolvedId) {
        try { localStorage.setItem(`wishgame:${result.room.id}:${cleanName}`, resolvedId); } catch {}
      }
      updateGameState(prev => ({
        ...prev,
        mode: 'IN_ROOM',
        currentRoom: result.room,
        currentPlayerId: result.asViewer ? undefined : resolvedId,
        isViewer: !!result.asViewer,
      }));
    } else {
      setErrorSafe(result.error || '加入房间失败');
    }
  };

  const leaveRoom = () => {
    updateGameState(prev => ({ mode: 'MENU', showResults: false }));
  };

  // 仅本人&非只读可改
  const updatePlayerWish = (playerId: string, wishIndex: number, text: string) => {
    if (!gameState.currentRoom) return;
    if (gameState.isViewer || playerId !== gameState.currentPlayerId) return;

    const sanitized = sanitizeText(text);
    const updatedRoom = roomAPI.updateRoom(gameState.currentRoom.id, room => ({
      ...room,
      players: room.players.map(p =>
        p.id === playerId ? { ...p, wishes: p.wishes.map((w, i) => i === wishIndex ? sanitized : w) } : p
      )
    }));
    if (updatedRoom) updateGameState(prev => ({ ...prev, currentRoom: updatedRoom }));
  };

  const addWishToPlayer = (playerId: string) => {
    if (!gameState.currentRoom) return;
    if (gameState.isViewer || playerId !== gameState.currentPlayerId) return;

    const updatedRoom = roomAPI.updateRoom(gameState.currentRoom.id, room => ({
      ...room,
      players: room.players.map(p =>
        p.id === playerId && p.wishes.length < 4 ? { ...p, wishes: [...p.wishes, ''] } : p
      )
    }));
    if (updatedRoom) updateGameState(prev => ({ ...prev, currentRoom: updatedRoom }));
  };

  const removeWishFromPlayer = (playerId: string, wishIndex: number) => {
    if (!gameState.currentRoom) return;
    if (gameState.isViewer || playerId !== gameState.currentPlayerId) return;

    const updatedRoom = roomAPI.updateRoom(gameState.currentRoom.id, room => ({
      ...room,
      players: room.players.map(p =>
        p.id === playerId && p.wishes.length > 2 ? { ...p, wishes: p.wishes.filter((_, i) => i !== wishIndex) } : p
      )
    }));
    if (updatedRoom) updateGameState(prev => ({ ...prev, currentRoom: updatedRoom }));
  };

  // 游戏流程
  const startGame = () => {
    if (!gameState.currentRoom) return;
    const players = gameState.currentRoom.players;

    // ✅ 至少 2 人
    if (players.length < 2) {
      setErrorSafe('至少需要2位玩家');
      return;
    }

    // ✅ 可选：至少存在两个分组，否则一定无法跨组匹配
    const groups = new Set(players.map(p => p.group || 'A'));
    if (groups.size < 2) {
      setErrorSafe('当前所有玩家都在同一组，无法进行跨组抽签，请调整分组');
      return;
    }

    const everyoneOk = players.every(p => p.wishes.filter(w => w.trim()).length >= 2 && p.locked === true);
    if (!everyoneOk) {
      setErrorSafe('每位玩家至少2个愿望并“锁定”后，房主才能开始');
      return;
    }

    const updatedRoom = roomAPI.updateRoom(gameState.currentRoom.id, room => ({ ...room, stage: 'LOCK_CONFIRM' }));
    if (updatedRoom) updateGameState(prev => ({ ...prev, currentRoom: updatedRoom }));
  };

  const confirmAndMatch = () => {
    if (!gameState.currentRoom) return;

    const wishes: Wish[] = [];
    gameState.currentRoom.players.forEach(player => {
      player.wishes.filter(w => w.trim()).forEach(wishText => {
        wishes.push({ id: `wish-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`, ownerId: player.id, text: wishText.trim() });
      });
    });

    const updatedRoom = roomAPI.updateRoom(gameState.currentRoom.id, room => ({ ...room, wishes, stage: 'MATCHING' }));
    if (updatedRoom) updateGameState(prev => ({ ...prev, currentRoom: updatedRoom }));
  };

  // 匹配动画 + 结果揭晓
  useEffect(() => {
    if (gameState.currentRoom?.stage === 'MATCHING') {
      setShowMatchFX(true);
      const timer = setTimeout(() => {
        if (!mountedRef.current || !gameState.currentRoom) return;
        try {
          const pairs = matchWishes(gameState.currentRoom.players, gameState.currentRoom.wishes, gameState.currentRoom.seed);
          const updatedRoom = roomAPI.updateRoom(gameState.currentRoom.id, room => ({ ...room, pairs, stage: 'REVEALED' }));
          if (updatedRoom) {
            updateGameState(prev => ({ ...prev, currentRoom: updatedRoom }));
            try { confetti({ particleCount: 120, spread: 70, origin: { y: 0.6 } }); } catch {}
          }
        } catch (error) {
          setErrorSafe(error instanceof Error ? error.message : '匹配失败');
        } finally {
          setShowMatchFX(false);
        }
      }, 2500); // 动画时长 2.5s
      return () => clearTimeout(timer);
    }
  }, [gameState.currentRoom?.stage]);

  // 主菜单
  if (gameState.mode === 'MENU') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-50 to-pink-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full text-center">
          <div className="mb-8">
            <Heart className="w-16 h-16 text-pink-500 mx-auto mb-4" />
            <h1 className="text-3xl font-bold text-gray-800 mb-2">愿望抽签</h1>
            <p className="text-gray-600">创建房间，邀请朋友一起许愿抽签</p>
          </div>
          <div className="space-y-4">
            <button onClick={() => updateGameState(prev => ({ ...prev, mode: 'CREATE_ROOM' }))} className="w-full bg-gradient-to-r from-purple-500 to-pink-500 text-white py-4 px-6 rounded-xl font-semibold hover:from-purple-600 hover:to-pink-600 transition-all transform hover:scale-105 flex items-center justify-center gap-2">
              <Plus className="w-5 h-5" /> 创建房间
            </button>
            <button onClick={() => updateGameState(prev => ({ ...prev, mode: 'JOIN_ROOM' }))} className="w-full bg-gray-100 text-gray-700 py-4 px-6 rounded-xl font-semibold hover:bg-gray-200 transition-all flex items-center justify-center gap-2">
              <Search className="w-5 h-5" /> 加入房间
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 创建房间
  if (gameState.mode === 'CREATE_ROOM') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-50 to-pink-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full">
          <div className="mb-6">
            <h2 className="text-2xl font-bold text-gray-800 mb-2">创建房间</h2>
            <p className="text-gray-600">设置房间密码和最大人数</p>
          </div>
          {error && (<div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4">{error}</div>)}
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">房间密码（4位）</label>
              <input type="text" value={roomPassword} onChange={(e) => setRoomPassword(e.target.value.slice(0, 4))} placeholder="输入4位密码" className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent text-center text-lg font-mono" maxLength={4} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">你的昵称（房主）</label>
              <input type="text" value={newPlayerName} onChange={(e) => setNewPlayerName(e.target.value)} placeholder="输入你的昵称" className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent" maxLength={20} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">最大人数</label>
              <select value={maxPlayers} onChange={(e) => setMaxPlayers(Number(e.target.value))} className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent">
                {[2,3,4,5,6,7,8,9,10].map(num => (<option key={num} value={num}>{num} 人</option>))}
              </select>
            </div>
          </div>
          <div className="mt-8 flex gap-3">
            <button onClick={() => updateGameState(prev => ({ ...prev, mode: 'MENU' }))} className="px-6 py-3 text-gray-600 hover:text-gray-800 transition-colors">返回</button>
            <button onClick={createRoom} disabled={roomPassword.length !== 4} className="flex-1 bg-gradient-to-r from-purple-500 to-pink-500 text-white py-3 px-6 rounded-xl font-semibold hover:from-purple-600 hover:to-pink-600 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2">
              <Lock className="w-4 h-4" /> 创建房间
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 加入房间
  if (gameState.mode === 'JOIN_ROOM') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-50 to-pink-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full">
          <div className="mb-6">
            <h2 className="text-2xl font-bold text-gray-800 mb-2">加入房间</h2>
            <p className="text-gray-600">输入房间号、密码和你的姓名</p>
          </div>
          {error && (<div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4">{error}</div>)}
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">房间号</label>
              <input type="text" value={joinRoomId} onChange={(e) => setJoinRoomId(e.target.value.toUpperCase())} placeholder="输入房间号" className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent text-center text-lg font-mono" maxLength={6} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">房间密码</label>
              <input type="text" value={joinPassword} onChange={(e) => setJoinPassword(e.target.value.slice(0, 4))} placeholder="输入密码" className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent text-center text-lg font-mono" maxLength={4} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">你的姓名</label>
              <input type="text" value={newPlayerName} onChange={(e) => setNewPlayerName(e.target.value)} placeholder="输入你的姓名" className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent" maxLength={20} />
            </div>
          </div>
          <div className="mt-8 flex gap-3">
            <button onClick={() => updateGameState(prev => ({ ...prev, mode: 'MENU' }))} className="px-6 py-3 text-gray-600 hover:text-gray-800 transition-colors">返回</button>
            <button onClick={joinRoom} disabled={!joinRoomId || !joinPassword || !newPlayerName} className="flex-1 bg-gradient-to-r from-blue-500 to-purple-500 text-white py-3 px-6 rounded-xl font-semibold hover:from-blue-600 hover:to-purple-600 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2">
              <UserPlus className="w-4 h-4" /> 加入房间
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 房间内
  if (gameState.mode === 'IN_ROOM' && gameState.currentRoom) {
    const room = gameState.currentRoom;
    const isViewer = !!gameState.isViewer;
    const currentPlayer = isViewer ? undefined : room.players.find(p => p.id === gameState.currentPlayerId);
    const isOwner = !!currentPlayer?.isOwner;

    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-50 to-pink-50 p-4 relative">
        <div className="max-w-2xl mx-auto">
          <div className="bg-white rounded-2xl shadow-xl p-6 relative">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-2xl font-bold text-gray-800">房间：{room.id}</h2>
                <p className="text-gray-600">密码：{room.password} | {room.players.length}/{room.maxPlayers} 人</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { if (navigator.clipboard) { navigator.clipboard.writeText(`房间号：${room.id}\n密码：${room.password}`); } }}
                  className="px-3 py-2 text-sm bg-blue-100 text-blue-700 rounded hover:bg-blue-200 transition-colors flex items-center gap-1"
                >
                  <Copy className="w-4 h-4" /> 分享
                </button>
                <button onClick={leaveRoom} className="px-3 py-2 text-sm bg-red-100 text-red-700 rounded hover:bg-red-200 transition-colors flex items-center gap-1">
                  <Home className="w-4 h-4" /> 离开
                </button>
              </div>
            </div>

            {isViewer && (
              <div className="mb-4 rounded-lg bg-yellow-50 border border-yellow-200 text-yellow-800 px-3 py-2 text-sm">
                只读查看模式（房间已满或以查看者身份进入），你不能编辑或参与匹配。
              </div>
            )}

            {error && (<div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4">{error}</div>)}

            <div className="space-y-4">
              {room.players.map((player, index) => {
                const isCurrentPlayer = player.id === gameState.currentPlayerId;
                const wishCount = player.wishes.filter(w => w.trim()).length;

                return (
                  <div key={player.id} className={`border rounded-lg p-4 ${isCurrentPlayer ? 'border-purple-300 bg-purple-50' : 'border-gray-200'}`}>
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 bg-gradient-to-r from-purple-500 to-pink-500 rounded-full flex items-center justify-center text-white text-sm font-semibold">{index + 1}</div>
                        <h3 className="text-lg font-semibold text-gray-800">
                          {player.name}
                          {player.isOwner && <span className="ml-2 text-xs bg-yellow-100 text-yellow-800 px-2 py-1 rounded">房主</span>}
                          {isCurrentPlayer && !isViewer && <span className="ml-2 text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">你</span>}
                          {/* ✅ 组徽标 */}
                          <span className="ml-2 text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded">{player.group || 'A'} 组</span>
                        </h3>
                        <span className="text-sm text-gray-500">({wishCount}/4 个愿望)</span>
                        {player.locked && <span className="ml-2 text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded">已锁定</span>}
                      </div>

                      {isCurrentPlayer && !isViewer && (
                        <button onClick={() => setEditingPlayer(editingPlayer === player.id ? null : player.id)} className="px-3 py-1 text-sm bg-blue-100 text-blue-700 rounded hover:bg-blue-200 transition-colors">
                          {editingPlayer === player.id ? '收起' : '编辑愿望'}
                        </button>
                      )}
                    </div>

                    {editingPlayer === player.id && isCurrentPlayer && !isViewer && (
                      <div className="space-y-3">
                        {player.wishes.map((wish, wishIndex) => (
                          <div key={wishIndex} className="flex gap-2">
                            <input type="text" value={wish} onChange={(e) => updatePlayerWish(player.id, wishIndex, e.target.value)} placeholder={`愿望 ${wishIndex + 1}`} className="flex-1 px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm" maxLength={120} />
                            {player.wishes.length > 2 && (
                              <button onClick={() => removeWishFromPlayer(player.id, wishIndex)} className="px-2 py-2 text-red-600 hover:text-red-800">
                                <Minus className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        ))}

                        {player.wishes.length < 4 && (
                          <button onClick={() => addWishToPlayer(player.id)} className="w-full py-2 text-sm text-purple-600 border border-purple-200 border-dashed rounded hover:bg-purple-50 transition-colors flex items-center justify-center gap-2">
                            <Plus className="w-4 h-4" /> 添加愿望
                          </button>
                        )}

                        {/* ✅ 选择分组（仅本人可改） */}
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-gray-600">我的分组：</span>
                          <select
                            value={player.group || 'A'}
                            onChange={(e) => {
                              const newGroup = e.target.value;
                              const updatedRoom = roomAPI.updateRoom(room.id, r => ({
                                ...r,
                                players: r.players.map(p =>
                                  p.id === player.id ? { ...p, group: newGroup } : p
                                )
                              }));
                              if (updatedRoom) {
                                updateGameState(prev => ({ ...prev, currentRoom: updatedRoom }));
                              }
                            }}
                            className="px-2 py-1 border rounded text-sm"
                          >
                            {['A','B','C','D'].map(g => (
                              <option key={g} value={g}>{g} 组</option>
                            ))}
                          </select>
                          <span className="text-xs text-gray-400">（跨组抽签，不能抽到同组愿望）</span>
                        </div>

                        {/* 锁定按钮 */}
                        {isCurrentPlayer && !isViewer && (
                          <div className="mt-3 flex items-center gap-2">
                            <button
                              onClick={() => {
                                const updatedRoom = roomAPI.updateRoom(room.id, r => ({
                                  ...r,
                                  players: r.players.map(p => p.id === player.id ? { ...p, locked: !p.locked } : p)
                                }));
                                if (updatedRoom) updateGameState(prev => ({ ...prev, currentRoom: updatedRoom }));
                              }}
                              className={`px-3 py-1 text-sm rounded ${player.locked ? 'bg-green-100 text-green-700 hover:bg-green-200' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
                            >
                              {player.locked ? '已锁定（点击解锁）' : '锁定我的愿望'}
                            </button>
                          </div>
                        )}
                      </div>
                    )}

                    {editingPlayer !== player.id && (
                      <div className="text-sm text-gray-600">
                        已添加 {wishCount} 个愿望
                        {!player.locked && wishCount < 2 && <span className="text-red-500 ml-2">⚠️ 至少需要2个</span>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* 房主开始按钮 */}
            {isOwner && !isViewer && room.players.length >= 2 && (
              <div className="mt-6 pt-6 border-t">
                <button onClick={startGame} className="w-full bg-gradient-to-r from-green-500 to-blue-500 text-white py-3 px-6 rounded-xl font-semibold hover:from-green-600 hover:to-blue-600 transition-all flex items-center justify-center gap-2">
                  <Check className="w-4 h-4" /> 开始游戏
                </button>
              </div>
            )}

            {/* 阶段提示/操作 */}
            {room.stage === 'LOCK_CONFIRM' && (
              <div className="mt-6 pt-6 border-t">
                {isOwner && !isViewer ? (
                  <div className="space-y-3">
                    <div className="text-center text-gray-700">所有玩家已锁定，是否现在进行匹配？</div>
                    <button
                      onClick={confirmAndMatch}
                      className="w-full bg-gradient-to-r from-purple-500 to-pink-500 text-white py-3 px-6 rounded-xl font-semibold hover:from-purple-600 hover:to-pink-600 transition-all flex items-center justify-center gap-2"
                    >
                      <Shuffle className="w-4 h-4" /> 确认并开始匹配
                    </button>
                  </div>
                ) : (
                  <div className="text-center text-gray-700">房主已准备匹配，请稍候…</div>
                )}
              </div>
            )}

            {room.stage === 'MATCHING' && (
              <div className="mt-6 pt-6 border-t text-center text-gray-700">正在匹配中…</div>
            )}

            {room.stage === 'REVEALED' && (
              <div className="mt-6 pt-6 border-t">
                <h3 className="text-lg font-semibold mb-4 text-gray-800">匹配结果</h3>
                <div className="space-y-3">
                  {room.players.map(p => {
                    const pair = room.pairs.find(x => x.pickerId === p.id);
                    const wish = room.wishes.find(w => w.id === pair?.wishId);
                    const owner = wish ? room.players.find(u => u.id === wish.ownerId) : undefined;
                    return (
                      <div key={p.id} className="flex items-start gap-3 p-3 rounded-lg border bg-gray-50">
                        <div className="w-7 h-7 rounded-full bg-gradient-to-r from-purple-500 to-pink-500 text-white flex items-center justify-center text-xs mt-1">{p.name.slice(0,1)}</div>
                        <div className="flex-1">
                          <div className="font-medium text-gray-800">{p.name} 抽到了：</div>
                          {wish ? (
                            <div className="mt-1 text-gray-700">
                              “{wish.text}”
                              <span className="ml-2 text-sm text-gray-500">（来自 {owner?.name || '未知'}）</span>
                            </div>
                          ) : (
                            <div className="mt-1 text-red-600 text-sm">未找到匹配结果</div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 匹配动画遮罩 */}
            <AnimatePresence>
              {showMatchFX && <MatchingOverlay wishes={room.wishes} />}
            </AnimatePresence>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

// =====================
// 动画层组件
// =====================
function MatchingOverlay({ wishes }: { wishes: Wish[] }) {
  const samples = wishes.length
    ? wishes.map(w => w.text).slice(0, 20)
    : ['愿望收集中', '正在洗牌', '准备抽签'];

  return (
    <motion.div
      className="fixed inset-0 z-50 backdrop-blur-sm bg-white/60 flex items-center justify-center"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <div className="relative w-full max-w-xl mx-auto">
        {/* 心形脉冲 */}
        <motion.div
          className="mx-auto w-20 h-20 rounded-full flex items-center justify-center"
          initial={{ scale: 0.8, opacity: 0.7 }}
          animate={{ scale: [0.8, 1.05, 0.8], opacity: [0.7, 1, 0.7] }}
          transition={{ duration: 1.2, repeat: Infinity }}
        >
          <Heart className="w-12 h-12 text-pink-500" />
        </motion.div>

        {/* 文案 */}
        <div className="mt-6 h-10 overflow-hidden">
          <motion.div
            key="matching-text"
            initial={{ y: 30, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -30, opacity: 0 }}
            transition={{ duration: 0.4 }}
            className="text-center text-gray-700"
          >
            正在随机分配愿望…
          </motion.div>
        </div>

        {/* 漂浮卡片 */}
        <div className="pointer-events-none">
          {[...Array(16)].map((_, i) => (
            <FloatCard key={i} index={i} samples={samples} />
          ))}
        </div>

        {/* 进度条 */}
        <div className="mt-8 h-2 w-64 mx-auto bg-gray-200 rounded-full overflow-hidden">
          <motion.div
            className="h-full bg-gradient-to-r from-purple-500 to-pink-500"
            initial={{ width: '0%' }}
            animate={{ width: '100%' }}
            transition={{ duration: 2.2, ease: 'easeInOut' }}
          />
        </div>
      </div>
    </motion.div>
  );
}

function FloatCard({ index, samples }: { index: number; samples: string[] }) {
  const text = samples[(index * 7) % samples.length] || '愿望';
  const delay = (index % 8) * 0.15;
  const startX = (index * 37) % 100;

  return (
    <motion.div
      className="absolute"
      style={{ left: `${startX}%`, top: `${(index * 53) % 90}%` }}
      initial={{ y: 20, opacity: 0, rotate: -6 }}
      animate={{ y: [20, -20, 20], opacity: [0, 1, 0.6, 1], rotate: [-6, 6, -6] }}
      transition={{ duration: 2.4, delay, repeat: Infinity, ease: 'easeInOut' }}
    >
      <div className="px-3 py-1 rounded-xl shadow bg-white/90 border text-gray-700 text-xs max-w-[240px] truncate">
        {text}
      </div>
    </motion.div>
  );
}
