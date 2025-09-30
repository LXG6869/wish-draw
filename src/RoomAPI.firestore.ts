// src/RoomAPI.firestore.ts
import { db } from './firebase';
import {
  doc, getDoc, setDoc, updateDoc, onSnapshot,
  serverTimestamp
} from 'firebase/firestore';

export interface Player { id: string; name: string; wishes: string[]; isOwner?: boolean; locked?: boolean }
export interface Wish { id: string; ownerId: string; text: string }
export interface MatchPair { pickerId: string; wishId: string }
export type Stage = 'WAITING' | 'COLLECTING' | 'LOCK_CONFIRM' | 'MATCHING' | 'REVEALED' | 'FINISHED';
export interface Room {
  id: string;
  password: string; // 仅示例，生产请考虑不要明文存放，或改为 hash
  ownerId: string;
  maxPlayers: number;
  players: Player[];
  stage: Stage;
  wishes: Wish[];
  pairs: MatchPair[];
  seed: string;
  createdAt: number;
}

export class FirestoreRoomAPI {
  private genId(len = 6) {
    return Math.random().toString(36).slice(2, 2 + len).toUpperCase();
  }
  private seed() {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  async createRoom(password: string, maxPlayers: number, ownerId: string, ownerName: string): Promise<Room> {
    const id = this.genId(6);
    const room: Room = {
      id,
      password,
      ownerId,
      maxPlayers,
      players: [{ id: ownerId, name: ownerName || '房主', wishes: ['', ''], isOwner: true, locked: false }],
      stage: 'WAITING',
      wishes: [],
      pairs: [],
      seed: this.seed(),
      createdAt: Date.now(),
    };
    await setDoc(doc(db, 'rooms', id), { ...room, _ts: serverTimestamp() });
    return room;
  }

  async joinRoom(
    roomId: string,
    password: string,
    playerId: string,
    playerName: string
  ): Promise<{ success: boolean; error?: string; room?: Room; asViewer?: boolean; resolvedPlayerId?: string }>{
    const ref = doc(db, 'rooms', roomId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return { success: false, error: '房间不存在' };
    const room = snap.data() as Room;
    if (room.password !== password) return { success: false, error: '密码错误' };

    const existingById = room.players.find(p => p.id === playerId);
    const sameName = room.players.find(p => p.name === playerName);
    if (existingById) return { success: true, room, asViewer: false, resolvedPlayerId: existingById.id };
    if (sameName) return { success: true, room, asViewer: false, resolvedPlayerId: sameName.id };

    if (room.players.length >= room.maxPlayers) {
      return { success: true, room, asViewer: true };
    }

    const newPlayers = [...room.players, { id: playerId, name: playerName, wishes: ['', ''], isOwner: false, locked: false }];
    const updated = { ...room, players: newPlayers };
    await updateDoc(ref, { players: newPlayers, _ts: serverTimestamp() });
    return { success: true, room: updated, asViewer: false, resolvedPlayerId: playerId };
  }

  async updateRoom(roomId: string, updater: (room: Room) => Room) {
    const ref = doc(db, 'rooms', roomId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    const current = snap.data() as Room;
    const updated = updater(current);
    await updateDoc(ref, { ...updated, _ts: serverTimestamp() });
    return updated;
  }

  subscribeRoom(roomId: string, onChange: (room: Room) => void) {
    const ref = doc(db, 'rooms', roomId);
    return onSnapshot(ref, (snap) => {
      if (snap.exists()) onChange(snap.data() as Room);
    });
  }
}
