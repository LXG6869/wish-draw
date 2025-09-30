// src/api/SupabaseRoomAPI.ts
import { supabase } from '../lib/supabaseClient';

export interface Player {
  id: string;
  name: string;
  wishes: string[];
  isOwner?: boolean;
  locked?: boolean;
  group?: string;
}

export interface Wish { 
  id: string; 
  ownerId: string; 
  text: string; 
}

export interface MatchPair { 
  pickerId: string; 
  wishId: string; 
}

export interface Room {
  id: string;
  passcode: string;  // ✅ 统一使用 passcode
  ownerId: string;
  maxPlayers: number;
  players: Player[];
  stage: 'WAITING'|'COLLECTING'|'LOCK_CONFIRM'|'MATCHING'|'REVEALED'|'FINISHED';
  wishes: Wish[];
  pairs: MatchPair[];
  seed: string;
  createdAt: number;
}

function generateRoomId() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

function generateSeed() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

type JoinResult =
  | { success: true; room: Room; asViewer?: boolean; resolvedPlayerId?: string }
  | { success: false; error: string };

export class SupabaseRoomAPI {
  async createRoom(passcode: string, maxPlayers: number, ownerId: string, ownerName: string): Promise<Room> {
    const room: Room = {
      id: generateRoomId(),
      passcode,
      ownerId,
      maxPlayers,
      players: [{
        id: ownerId,
        name: ownerName || '房主',
        wishes: ['', ''],
        isOwner: true,
        locked: false,
        group: 'A',
      }],
      stage: 'WAITING',
      wishes: [],
      pairs: [],
      seed: generateSeed(),
      createdAt: Date.now(),
    };

    // ✅ 插入时包含 passcode 列和 data 列
    const { error } = await supabase
      .from('rooms')
      .insert([{ 
        id: room.id, 
        passcode: room.passcode, 
        data: room,
        updated_at: new Date().toISOString()
      }]);

    if (error) {
      console.error('创建房间失败:', error);
      throw new Error(error.message);
    }
    
    return room;
  }

  async getRoom(roomId: string): Promise<Room | null> {
    const { data, error } = await supabase
      .from('rooms')
      .select('data')
      .eq('id', roomId)
      .single();

    if (error) {
      console.error('获取房间失败:', error);
      return null;
    }
    
    if (!data) return null;
    return data.data as Room;
  }

  async joinRoom(roomId: string, passcode: string, playerId: string, playerName: string): Promise<JoinResult> {
    // 取整行，拿到 passcode 校验
    const { data, error } = await supabase
      .from('rooms')
      .select('id, passcode, data')
      .eq('id', roomId)
      .single();

    if (error || !data) {
      console.error('加入房间失败:', error);
      return { success: false, error: '房间不存在' };
    }

    if (data.passcode !== passcode) {
      return { success: false, error: '密码错误' };
    }

    const room = data.data as Room;

    // 重连（按 id / name）
    const byId   = room.players.find(p => p.id === playerId);
    const byName = room.players.find(p => p.name === playerName);
    
    if (byId)   return { success: true, room, asViewer: false, resolvedPlayerId: byId.id };
    if (byName) return { success: true, room, asViewer: false, resolvedPlayerId: byName.id };

    // 满员 → 只读
    if (room.players.length >= room.maxPlayers) {
      return { success: true, room, asViewer: true };
    }

    // 加入：分配到人数最少的组
    const groups = ['A','B','C','D'];
    const counts = groups.map(g => room.players.filter(p => p.group === g).length);
    const group  = groups[counts.indexOf(Math.min(...counts))];

    const updated: Room = {
      ...room,
      players: [
        ...room.players,
        { id: playerId, name: playerName, wishes: ['', ''], isOwner: false, locked: false, group }
      ],
    };

    const { error: updErr } = await supabase
      .from('rooms')
      .update({ 
        data: updated,
        updated_at: new Date().toISOString()
      })
      .eq('id', roomId);

    if (updErr) {
      console.error('更新房间失败:', updErr);
      return { success: false, error: updErr.message };
    }
    
    return { success: true, room: updated, asViewer: false, resolvedPlayerId: playerId };
  }

  /** 通用更新：拉取 -> 应用 updater -> 回写 */
  async updateRoom(roomId: string, updater: (r: Room) => Room): Promise<Room | null> {
    const cur = await this.getRoom(roomId);
    if (!cur) return null;
    
    const updated = updater(cur);
    
    const { error } = await supabase
      .from('rooms')
      .update({ 
        data: updated,
        updated_at: new Date().toISOString()
      })
      .eq('id', roomId);
      
    if (error) {
      console.error('更新房间失败:', error);
      return null;
    }
    
    return updated;
  }

  /** 订阅单个房间变化（需在 Realtime 中勾选 rooms） */
  subscribe(roomId: string, onChange: (r: Room) => void) {
    const ch = supabase
      .channel(`rooms:${roomId}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'rooms', filter: `id=eq.${roomId}` },
        (payload) => {
          const newRoom = (payload.new as any)?.data as Room;
          if (newRoom) onChange(newRoom);
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(ch); };
  }
}