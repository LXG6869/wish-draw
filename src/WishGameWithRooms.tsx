// src/WishGameWithRooms.tsx
// ------------------------------------------------------------
// ✅ Supabase 持久化 + 实时订阅；若未配置环境变量则自动退化为"本地内存模式"(单设备),
//    以避免 "Cannot read properties of undefined (reading 'VITE_SUPABASE_URL')"。
//    .env(根目录):
//      VITE_SUPABASE_URL=https://xxxx.supabase.co
//      VITE_SUPABASE_ANON_KEY=eyJhbGciOi...
//    Supabase 表:
//      create table if not exists public.rooms (
//        id text primary key,
//        passcode text not null,
//        payload jsonb not null,
//        updated_at timestamptz default now()
//      );
// ------------------------------------------------------------

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import confetti from 'canvas-confetti';
import { Heart, Shuffle, Plus, Minus, Check, Lock, Search, UserPlus, Copy, Home } from 'lucide-react';
import { createClient, RealtimeChannel } from '@supabase/supabase-js';

// ========== 类型 ==========
interface Player { id: string; name: string; wishes: string[]; isOwner?: boolean; locked?: boolean; group?: string }
interface Wish { id: string; ownerId: string; text: string }
interface MatchPair { pickerId: string; wishId: string }

type Stage = 'WAITING'|'COLLECTING'|'LOCK_CONFIRM'|'MATCHING'|'REVEALED'|'FINISHED';
interface Room { id: string; passcode: string; ownerId: string; maxPlayers: number; players: Player[]; stage: Stage; wishes: Wish[]; pairs: MatchPair[]; seed: string; createdAt: number }
interface GameState { mode: 'MENU'|'CREATE_ROOM'|'JOIN_ROOM'|'IN_ROOM'; currentRoom?: Room; currentPlayerId?: string; isViewer?: boolean }

// ========== 环境 & Supabase 客户端(可选) ==========
const VITE_ENV: any = (typeof import.meta !== 'undefined' && (import.meta as any).env) ? (import.meta as any).env : {};
const SUPABASE_URL: string | undefined = VITE_ENV?.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY: string | undefined = VITE_ENV?.VITE_SUPABASE_ANON_KEY;
const HAS_SUPABASE = !!(SUPABASE_URL && SUPABASE_ANON_KEY);
const supabase = HAS_SUPABASE ? createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!) : null;
const TABLE = 'rooms';

// ========== 本地回退 ==========
const memStore = new Map<string, Room>();
async function loadRoom(id: string): Promise<Room | null> {
  if (supabase) { const { data, error } = await supabase.from(TABLE).select('payload').eq('id', id).maybeSingle(); if (error) throw error; return (data?.payload as Room) ?? null; }
  return memStore.get(id) ?? null;
}
async function saveRoom(room: Room): Promise<Room> {
  if (supabase) { const { error } = await supabase.from(TABLE).upsert({ id: room.id, passcode: room.passcode, payload: room, updated_at: new Date().toISOString() }); if (error) throw error; return room; }
  memStore.set(room.id, room); try { window.dispatchEvent(new CustomEvent('memroom:update', { detail: { id: room.id } })); } catch {} return room;
}

function newRoomId(){return Math.random().toString(36).slice(2,8).toUpperCase()} function newSeed(){return `${Date.now()}-${Math.random().toString(36).slice(2)}`} function newPlayerId(){return `player-${Date.now()}-${Math.random().toString(36).slice(2)}`} function clean(s:string){return s.trim().replace(/\s+/g,' ').slice(0,120)}

// ========== 匹配 ==========
class SeededRandom{private s:number;constructor(x:string){let h=0;for(let i=0;i<x.length;i++){h=((h<<5)-h)+x.charCodeAt(i);h|=0}this.s=Math.abs(h)}next(){this.s=(this.s*9301+49297)%233280;return this.s/233280}shuffle<T>(a:T[]){const r=[...a];for(let i=r.length-1;i>0;i--){const j=Math.floor(this.next()*(i+1));[r[i],r[j]]=[r[j],r[i]]}return r}}
function matchWishes(players: Player[], wishes: Wish[], seed: string): MatchPair[] {
  for (let attempt=0; attempt<7; attempt++){
    const atSeed=seed+'|'+attempt; const groupOf=new Map(players.map(p=>[p.id,p.group||'A'])); const wById=new Map(wishes.map(w=>[w.id,w])); const all=wishes.map(w=>w.id);
    const cand=new Map<string,string[]>();
    for(const p of players){ const myG=groupOf.get(p.id)||'A'; const list=all.filter(id=>{const w=wById.get(id)!;return w.ownerId!==p.id && (groupOf.get(w.ownerId)||'A')!==myG}); if(!list.length) throw new Error(`玩家「${p.name}」没有可选愿望`); cand.set(p.id,new SeededRandom(atSeed+'#c#'+p.id).shuffle(list)); }
    const order=new SeededRandom(atSeed+'#o').shuffle(players.map(p=>p.id)); const wishAssigned=new Map<string,string>(); const pickWish=new Map<string,string>();
    function tryAug(pid:string, seen:Set<string>):boolean{ const opts=cand.get(pid)!; for(const wid of opts){ if(seen.has(wid)) continue; seen.add(wid); const cur=wishAssigned.get(wid); if(!cur || tryAug(cur, seen)){ wishAssigned.set(wid,pid); pickWish.set(pid,wid); return true } } return false }
    let ok=true; for(const pid of order){ if(!tryAug(pid,new Set())){ ok=false; break } } if(ok) return Array.from(pickWish.entries()).map(([pickerId,wishId])=>({pickerId,wishId}));
  }
  throw new Error('当前条件下无法完成跨组分配,请增加参与者/愿望或调整分组');
}

// ========== 组件 ==========
export default function WishGameWithRooms(){
  const [state,setState]=useState<GameState>({mode:'MENU'}); const [error,setError]=useState('');
  const [roomPassword,setRoomPassword]=useState(''); const [maxPlayers,setMaxPlayers]=useState(2); const [newPlayerName,setNewPlayerName]=useState('');
  const [joinRoomId,setJoinRoomId]=useState(''); const [joinPassword,setJoinPassword]=useState(''); const [spinning,setSpinning]=useState(false);
  const subRef=useRef<RealtimeChannel|null>(null); const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;subRef.current?.unsubscribe()}},[]); const setErrorSafe=(m:string)=>mounted.current&&setError(m); const setStateSafe=(u:(p:GameState)=>GameState)=>{if(mounted.current){setState(u);setError('')}}

  // 订阅
  useEffect(()=>{ const roomId=state.currentRoom?.id; if(!roomId) return;
    if(!supabase){ const h=(e:Event)=>{const d=(e as CustomEvent).detail as any; if(d?.id===roomId){ loadRoom(roomId).then(latest=>{ if(latest) setStateSafe(p=>({...p,currentRoom:latest})) }) }}; window.addEventListener('memroom:update' as any,h as any); return ()=>window.removeEventListener('memroom:update' as any,h as any);
    }
    subRef.current?.unsubscribe(); const ch=supabase.channel(`room-${roomId}`).on('postgres_changes',{event:'*',schema:'public',table:TABLE,filter:`id=eq.${roomId}`},async()=>{const latest=await loadRoom(roomId); if(latest) setStateSafe(p=>({...p,currentRoom:latest}))}).subscribe(); subRef.current=ch; return ()=>{ch.unsubscribe()}
  },[state.currentRoom?.id]);

  // 复制提示
  const [copySuccess, setCopySuccess] = useState(false);
  const handleCopyRoom = (roomId: string, passcode: string) => {
    const text = `${roomId}`;
    
    // 方法1: 现代 Clipboard API
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(() => {
        setCopySuccess(true);
        setTimeout(() => setCopySuccess(false), 2000);
      }).catch(() => {
        // 失败时使用备用方法
        fallbackCopy(text);
      });
    } else {
      // 方法2: 传统方法（兼容性更好）
      fallbackCopy(text);
    }
  };

  const fallbackCopy = (text: string) => {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    
    try {
      const successful = document.execCommand('copy');
      if (successful) {
        setCopySuccess(true);
        setTimeout(() => setCopySuccess(false), 2000);
      } else {
        setErrorSafe('复制失败，请手动复制');
      }
    } catch (err) {
      setErrorSafe('复制失败，请手动复制');
    }
    
    document.body.removeChild(textArea);
  };

  // 房间操作
  const createRoom=async()=>{ 
    if(roomPassword.length!==4) return setErrorSafe('密码必须 4 位'); 
    if(!newPlayerName.trim()) return setErrorSafe('请输入你的昵称');
    const pid=newPlayerId(); 
    const name=clean(newPlayerName); 
    const room:Room={ id:newRoomId(), passcode:roomPassword, ownerId:pid, maxPlayers, players:[{id:pid,name,wishes:['',''],isOwner:true,locked:false,group:'A'}], stage:'WAITING', wishes:[], pairs:[], seed:newSeed(), createdAt:Date.now() }; 
    await saveRoom(room); 
    try{localStorage.setItem(`wishgame:${room.id}:${name}`,pid)}catch{} 
    setStateSafe(p=>({...p,mode:'IN_ROOM',currentRoom:room,currentPlayerId:pid,isViewer:false})) 
  };
  const joinRoom=async()=>{ if(!joinRoomId||!joinPassword||!newPlayerName) return setErrorSafe('请填写完整信息'); const id=joinRoomId.toUpperCase(); const room=await loadRoom(id); if(!room) return setErrorSafe('房间不存在'); if(room.passcode!==joinPassword) return setErrorSafe('密码错误'); const nick=clean(newPlayerName); let pid=''; try{pid=localStorage.getItem(`wishgame:${id}:${nick}`)||''}catch{} if(!pid) pid=newPlayerId(); const byId=room.players.find(p=>p.id===pid); const same=room.players.find(p=>p.name===nick);
    if(!byId && !same){ if(room.players.length>=room.maxPlayers){ setStateSafe(p=>({...p,mode:'IN_ROOM',currentRoom:room,currentPlayerId:undefined,isViewer:true})); return } const groups=['A','B','C','D']; const cnt=groups.map(g=>room.players.filter(p=>p.group===g).length); const g=groups[cnt.indexOf(Math.min(...cnt))]; const upd:Room={...room,players:[...room.players,{id:pid,name:nick,wishes:['',''],isOwner:false,locked:false,group:g}]}; await saveRoom(upd); try{localStorage.setItem(`wishgame:${id}:${nick}`,pid)}catch{} setStateSafe(p=>({...p,mode:'IN_ROOM',currentRoom:upd,currentPlayerId:pid,isViewer:false})) }
    else { const resolved=byId?.id||same?.id; if(resolved) try{localStorage.setItem(`wishgame:${id}:${nick}`,resolved)}catch{} setStateSafe(p=>({...p,mode:'IN_ROOM',currentRoom:room,currentPlayerId:resolved,isViewer:false})) }
  };
  const updateRoom=async(up:(r:Room)=>Room)=>{ if(!state.currentRoom) return; const latest=await loadRoom(state.currentRoom.id); if(!latest) return; const upd=up(latest); await saveRoom(upd); setStateSafe(p=>({...p,currentRoom:upd})) };
  const leaveRoom=()=>setStateSafe(()=>({mode:'MENU'}));

  // 愿望编辑
  const updatePlayerWish=(pid:string,i:number,t:string)=>{ if(!state.currentRoom||state.isViewer||state.currentPlayerId!==pid) return; updateRoom(r=>({...r,players:r.players.map(p=>p.id===pid?{...p,wishes:p.wishes.map((w,ii)=>ii===i?clean(t):w)}:p)})) };
  const addWishToPlayer=(pid:string)=>{ if(!state.currentRoom||state.isViewer||state.currentPlayerId!==pid) return; updateRoom(r=>({...r,players:r.players.map(p=>p.id===pid&&p.wishes.length<4?{...p,wishes:[...p.wishes,'']}:p)})) };
  const removeWishFromPlayer=(pid:string,i:number)=>{ if(!state.currentRoom||state.isViewer||state.currentPlayerId!==pid) return; updateRoom(r=>({...r,players:r.players.map(p=>p.id===pid&&p.wishes.length>2?{...p,wishes:p.wishes.filter((_,ii)=>ii!==i)}:p)})) };

  // 开始/确认匹配
  const startGame=()=>{ const r=state.currentRoom; if(!r) return; if(r.players.length<2) return setErrorSafe('至少需要 2 位玩家'); const groups=new Set(r.players.map(p=>p.group||'A')); if(groups.size<2) return setErrorSafe('所有玩家都在同一组,无法跨组抽签'); const ok=r.players.every(p=>p.locked && p.wishes.filter(w=>w.trim()).length>=2); if(!ok) return setErrorSafe('每位玩家需 ≥2 愿望且已锁定'); updateRoom(rr=>({...rr,stage:'LOCK_CONFIRM'})) };
  const confirmAndMatch=async()=>{ const r=state.currentRoom; if(!r) return; const wishes:Wish[]=[]; r.players.forEach(p=>p.wishes.filter(w=>w.trim()).forEach(t=>wishes.push({id:`w-${p.id}-${Math.random().toString(36).slice(2)}`,ownerId:p.id,text:t.trim()}))); await updateRoom(rr=>({...rr,wishes,seed:rr.seed+'|'+Date.now(),stage:'MATCHING'})); setSpinning(true); setTimeout(async()=>{ try{ const latest=await loadRoom(r.id); if(!latest) return; const pairs=matchWishes(latest.players, latest.wishes, latest.seed); await saveRoom({...latest,pairs,stage:'REVEALED'}); try{confetti({particleCount:140,spread:70,origin:{y:0.6}})}catch{} }catch(e:any){ setErrorSafe(e?.message||'匹配失败') }finally{ if(mounted.current) setSpinning(false) } }, 2600) };

  const Banner=()=>!supabase?(<div className="mb-4 rounded-lg bg-yellow-50 border border-yellow-200 text-yellow-800 px-3 py-2 text-sm">未配置 <code>VITE_SUPABASE_URL</code>/<code>VITE_SUPABASE_ANON_KEY</code>,已启用本地内存模式(仅单设备)。</div>):null;

  // 界面:菜单
  if(state.mode==='MENU') return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 to-pink-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full text-center">
        <div className="mb-8"><Heart className="w-16 h-16 text-pink-500 mx-auto mb-4"/><h1 className="text-3xl font-bold text-gray-800 mb-2">愿望抽签</h1><p className="text-gray-600">创建房间,邀请朋友一起许愿抽签</p></div>
        <Banner/>
        <div className="space-y-4">
          <button onClick={()=>setState(p=>({...p,mode:'CREATE_ROOM'}))} className="w-full bg-gradient-to-r from-purple-500 to-pink-500 text-white py-4 px-6 rounded-xl font-semibold hover:from-purple-600 hover:to-pink-600 transition-all transform hover:scale-105 flex items-center justify-center gap-2"><Plus className="w-5 h-5"/> 创建房间</button>
          <button onClick={()=>setState(p=>({...p,mode:'JOIN_ROOM'}))} className="w-full bg-gray-100 text-gray-700 py-4 px-6 rounded-xl font-semibold hover:bg-gray-200 transition-all flex items-center justify-center gap-2"><Search className="w-5 h-5"/> 加入房间</button>
        </div>
      </div>
    </div>
  );

  // 界面:创建
  if(state.mode==='CREATE_ROOM') return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 to-pink-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full">
        <h2 className="text-2xl font-bold text-gray-800 mb-2">创建房间</h2>
        <Banner/>
        {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4">{error}</div>}
        <div className="space-y-4">
          <div><label className="block text-sm font-medium text-gray-700 mb-2">房间密码(4位)</label><input value={roomPassword} onChange={e=>setRoomPassword(e.target.value.slice(0,4))} className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent text-center text-lg font-mono" maxLength={4}/></div>
          <div><label className="block text-sm font-medium text-gray-700 mb-2">你的昵称(房主) <span className="text-red-500">*</span></label><input value={newPlayerName} onChange={e=>setNewPlayerName(e.target.value)} placeholder="请输入昵称" className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent" maxLength={20}/></div>
          <div><label className="block text-sm font-medium text-gray-700 mb-2">最大人数</label><select value={maxPlayers} onChange={e=>setMaxPlayers(Number(e.target.value))} className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent">{[2,3,4,5,6,7,8,9,10].map(n=><option key={n} value={n}>{n} 人</option>)}</select></div>
        </div>
        <div className="mt-8 flex gap-3"><button onClick={()=>setState(p=>({...p,mode:'MENU'}))} className="px-6 py-3 text-gray-600 hover:text-gray-800">返回</button><button onClick={createRoom} disabled={roomPassword.length!==4 || !newPlayerName.trim()} className="flex-1 bg-gradient-to-r from-purple-500 to-pink-500 text-white py-3 px-6 rounded-xl font-semibold hover:from-purple-600 hover:to-pink-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"><Lock className="w-4 h-4"/> 创建房间</button></div>
      </div>
    </div>
  );

  // 界面:加入
  if(state.mode==='JOIN_ROOM') return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 to-pink-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full">
        <h2 className="text-2xl font-bold text-gray-800 mb-2">加入房间</h2>
        <Banner/>
        {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4">{error}</div>}
        <div className="space-y-4">
          <div><label className="block text-sm font-medium text-gray-700 mb-2">房间号</label><input value={joinRoomId} onChange={e=>setJoinRoomId(e.target.value.toUpperCase())} className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent text-center text-lg font-mono" maxLength={6}/></div>
          <div><label className="block text-sm font-medium text-gray-700 mb-2">房间密码</label><input value={joinPassword} onChange={e=>setJoinPassword(e.target.value.slice(0,4))} className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent text-center text-lg font-mono" maxLength={4}/></div>
          <div><label className="block text-sm font-medium text-gray-700 mb-2">你的姓名</label><input value={newPlayerName} onChange={e=>setNewPlayerName(e.target.value)} className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent" maxLength={20}/></div>
        </div>
        <div className="mt-8 flex gap-3"><button onClick={()=>setState(p=>({...p,mode:'MENU'}))} className="px-6 py-3 text-gray-600 hover:text-gray-800">返回</button><button onClick={joinRoom} disabled={!joinRoomId||!joinPassword||!newPlayerName} className="flex-1 bg-gradient-to-r from-blue-500 to-purple-500 text-white py-3 px-6 rounded-xl font-semibold hover:from-blue-600 hover:to-purple-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"><UserPlus className="w-4 h-4"/> 加入房间</button></div>
      </div>
    </div>
  );

  // 界面:房间
  if(state.mode==='IN_ROOM' && state.currentRoom){
    const room=state.currentRoom; const isViewer=!!state.isViewer; const me=isViewer?undefined:room.players.find(p=>p.id===state.currentPlayerId); const isOwner=!!me?.isOwner;
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-50 to-pink-50 p-4 pb-24">
        <div className="max-w-2xl mx-auto">
          <div className="bg-white rounded-2xl shadow-xl p-6 relative">
            <div className="flex items-center justify-between mb-6">
              <div><h2 className="text-2xl font-bold text-gray-800">房间:{room.id}</h2><p className="text-gray-600">密码:{room.passcode} | {room.players.length}/{room.maxPlayers} 人</p></div>
              <div className="flex items-center gap-2">
                <button onClick={()=>handleCopyRoom(room.id, room.passcode)} className="px-3 py-2 text-sm bg-blue-100 text-blue-700 rounded hover:bg-blue-200 flex items-center gap-1">
                  <Copy className="w-4 h-4"/> {copySuccess ? '已复制!' : '分享'}
                </button>
                <button onClick={()=>setState({mode:'MENU'})} className="px-3 py-2 text-sm bg-red-100 text-red-700 rounded hover:bg-red-200 flex items-center gap-1">
                  <Home className="w-4 h-4"/> 离开
                </button>
              </div>
            </div>
            {!supabase && <div className="mb-4 rounded-lg bg-yellow-50 border border-yellow-200 text-yellow-800 px-3 py-2 text-sm">本地内存模式(未配置 Supabase),仅本设备有效。</div>}
            {isViewer && <div className="mb-4 rounded-lg bg-yellow-50 border border-yellow-200 text-yellow-800 px-3 py-2 text-sm">只读模式。</div>}
            {copySuccess && <div className="mb-4 rounded-lg bg-green-50 border border-green-200 text-green-800 px-3 py-2 text-sm">✓ 房间信息已复制到剪贴板</div>}
            {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4">{error}</div>}

            <div className="space-y-4">
              {room.players.map((p,idx)=>{ const isMe=p.id===state.currentPlayerId; const count=p.wishes.filter(w=>w.trim()).length; return (
                <div key={p.id} className={`border rounded-lg p-4 ${isMe?'border-purple-300 bg-purple-50':'border-gray-200'}`}>
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 bg-gradient-to-r from-purple-500 to-pink-500 rounded-full flex items-center justify-center text-white text-sm font-semibold">{idx+1}</div>
                      <h3 className="text-lg font-semibold text-gray-800">{p.name}{p.isOwner&&<span className="ml-2 text-xs bg-yellow-100 text-yellow-800 px-2 py-1 rounded">房主</span>}{isMe&&!isViewer&&<span className="ml-2 text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">你</span>}<span className="ml-2 text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded">{p.group||'A'} 组</span></h3>
                      <span className="text-sm text-gray-500">({count}/4 个愿望)</span>
                      {p.locked&&<span className="ml-2 text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded">已锁定</span>}
                    </div>
                  </div>
                  {isMe&&!isViewer && (
                    <div className="space-y-3">
                      {p.wishes.map((w,i)=>(
                        <div key={i} className="flex gap-2">
                          <input value={w} onChange={e=>updatePlayerWish(p.id,i,e.target.value)} placeholder={`愿望 ${i+1}`} className="flex-1 px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm" maxLength={120}/>
                          {p.wishes.length>2 && (<button onClick={()=>removeWishFromPlayer(p.id,i)} className="px-2 py-2 text-red-600 hover:text-red-800"><Minus className="w-4 h-4"/></button>)}
                        </div>
                      ))}
                      {p.wishes.length<4 && (<button onClick={()=>addWishToPlayer(p.id)} className="w-full py-2 text-sm text-purple-600 border border-purple-200 border-dashed rounded hover:bg-purple-50 flex items-center justify-center gap-2"><Plus className="w-4 h-4"/> 添加愿望</button>)}
                      <div className="flex items-center gap-2"><span className="text-sm text-gray-600">我的分组:</span><select value={p.group||'A'} onChange={e=>updateRoom(r=>({...r,players:r.players.map(x=>x.id===p.id?{...x,group:e.target.value}:x)}))} className="px-2 py-1 border rounded text-sm">{['A','B','C','D'].map(g=><option key={g} value={g}>{g} 组</option>)}</select><span className="text-xs text-gray-400">(跨组抽签,不能抽到同组)</span></div>
                      <div className="mt-3"><button onClick={()=>updateRoom(r=>({...r,players:r.players.map(x=>x.id===p.id?{...x,locked:!x.locked}:x)}))} className={`px-3 py-1 text-sm rounded ${p.locked?'bg-green-100 text-green-700 hover:bg-green-200':'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>{p.locked?'已锁定(点击解锁)':'锁定我的愿望'}</button></div>
                    </div>
                  )}
                  {!isMe && <div className="text-sm text-gray-600">已添加 {count} 个愿望{!p.locked&&count<2&&<span className="text-red-500 ml-2">⚠️ 至少需要2个</span>}</div>}
                </div>
              )})}
            </div>

            {isOwner && !isViewer && room.players.length>=2 && room.stage==='WAITING' && (
              <div className="mt-6 pt-6 border-t"><button onClick={startGame} className="w-full bg-gradient-to-r from-green-500 to-blue-500 text-white py-3 px-6 rounded-xl font-semibold hover:from-green-600 hover:to-blue-600 flex items-center justify-center gap-2"><Check className="w-4 h-4"/> 开始游戏</button></div>
            )}

            {room.stage==='LOCK_CONFIRM' && (
              <div className="mt-6 pt-6 border-t">{isOwner && !isViewer ? (
                <div className="space-y-3 text-center"><div className="text-gray-700">所有玩家已锁定,是否现在进行匹配?</div><button onClick={confirmAndMatch} className="w-full bg-gradient-to-r from-purple-500 to-pink-500 text-white py-3 px-6 rounded-xl font-semibold hover:from-purple-600 hover:to-pink-600 flex items-center justify-center gap-2"><Shuffle className="w-4 h-4"/> 确认并开始匹配</button></div>
              ) : (<div className="text-center text-gray-700">房主已准备匹配,请稍候…</div>)}</div>
            )}

            {room.stage==='MATCHING' && (<div className="mt-6 pt-6 border-t text-center text-gray-700">正在匹配中…</div>)}

            {room.stage==='REVEALED' && (
              <div className="mt-6 pt-6 border-t">
                <h3 className="text-lg font-semibold mb-4 text-gray-800">我的抽签结果</h3>
                {isViewer || !me ? (
                  <div className="text-gray-600 text-sm">你当前为查看者,不能查看他人结果。</div>
                ) : (()=>{ const pair=room.pairs.find(x=>x.pickerId===me.id); const wish=room.wishes.find(w=>w.id===pair?.wishId); const owner=wish?room.players.find(u=>u.id===wish.ownerId):undefined; return (
                  <div className="flex items-start gap-3 p-3 rounded-lg border bg-gray-50">
                    <div className="w-7 h-7 rounded-full bg-gradient-to-r from-purple-500 to-pink-500 text-white flex items-center justify-center text-xs mt-1">{me.name.slice(0,1)}</div>
                    <div className="flex-1">{wish? (<><div className="font-medium text-gray-800">你抽到了:</div><div className="mt-1 text-gray-700">"{wish.text}"<span className="ml-2 text-sm text-gray-500">(来自 {owner?.name||'未知'})</span></div></>):(<div className="text-sm text-red-600">未找到匹配结果</div>)}</div>
                  </div>
                ) })()}
                <div className="text-xs text-gray-400 mt-3">* 为保护隐私,其他人的结果仅他们自己可见。</div>
              </div>
            )}

            <AnimatePresence>{spinning && <ChristmasNineGridOverlay/>}</AnimatePresence>
          </div>
        </div>

        {/* 固定在底部的导航栏 - 移动端优化 */}
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-lg p-4 md:hidden z-10">
          <div className="max-w-2xl mx-auto flex justify-between items-center gap-3">
            <button 
              onClick={()=>handleCopyRoom(room.id, room.passcode)} 
              className="flex-1 px-4 py-3 bg-blue-100 text-blue-700 rounded-lg hover:bg-blue-200 flex items-center justify-center gap-2 font-medium"
            >
              <Copy className="w-5 h-5"/> {copySuccess ? '已复制!' : '分享房间'}
            </button>
            <button 
              onClick={()=>setState({mode:'MENU'})} 
              className="flex-1 px-4 py-3 bg-red-100 text-red-700 rounded-lg hover:bg-red-200 flex items-center justify-center gap-2 font-medium"
            >
              <Home className="w-5 h-5"/> 离开房间
            </button>
          </div>
        </div>

        {/* 开始游戏按钮 - 移动端固定在底部 */}
        {isOwner && !isViewer && room.players.length>=2 && room.stage==='WAITING' && (
          <div className="fixed bottom-0 left-0 right-0 bg-white border-t-2 border-green-200 shadow-lg p-4 md:hidden z-20">
            <div className="max-w-2xl mx-auto">
              <button 
                onClick={startGame} 
                className="w-full bg-gradient-to-r from-green-500 to-blue-500 text-white py-4 px-6 rounded-xl font-bold text-lg hover:from-green-600 hover:to-blue-600 flex items-center justify-center gap-2 shadow-lg"
              >
                <Check className="w-6 h-6"/> 开始游戏
              </button>
            </div>
          </div>
        )}

        {/* 确认匹配按钮 - 移动端固定在底部 */}
        {room.stage==='LOCK_CONFIRM' && isOwner && !isViewer && (
          <div className="fixed bottom-0 left-0 right-0 bg-white border-t-2 border-purple-200 shadow-lg p-4 md:hidden z-20">
            <div className="max-w-2xl mx-auto">
              <div className="text-center mb-3 text-gray-700 font-medium">所有玩家已锁定,是否现在进行匹配?</div>
              <button 
                onClick={confirmAndMatch} 
                className="w-full bg-gradient-to-r from-purple-500 to-pink-500 text-white py-4 px-6 rounded-xl font-bold text-lg hover:from-purple-600 hover:to-pink-600 flex items-center justify-center gap-2 shadow-lg"
              >
                <Shuffle className="w-6 h-6"/> 确认并开始匹配
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return null;
}

// ========== 圣诞九宫格覆盖层 ==========
function ChristmasNineGridOverlay(){
  const ring=[0,1,2,5,8,7,6,3]; const [idx,setIdx]=useState(0);
  useEffect(()=>{ let steps=0; let total=26+Math.floor(Math.random()*8); let interval=70; const tick=()=>{ setIdx(p=>(p+1)%ring.length); steps++; if(steps<total-8) setTimeout(tick,interval); else if(steps<total){ interval+=40; setTimeout(tick,interval) } }; const t=setTimeout(tick,interval); return ()=>clearTimeout(t); },[]);
  return (
    <motion.div className="fixed inset-0 z-50 flex items-center justify-center" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}>
      <div className="absolute inset-0 bg-gradient-to-br from-red-600 via-red-700 to-red-800">
        {[...Array(40)].map((_,i)=>(<div key={i} className="absolute text-white/60" style={{left:`${(i*23)%100}%`,top:`${(i*37)%100}%`,transform:`scale(${0.6+(i%5)/10})`,filter:'drop-shadow(0 0 2px rgba(255,255,255,0.8))'}}>❄</div>))}
        <div className="absolute left-6 top-6 text-4xl">🎅</div><div className="absolute right-8 top-10 text-4xl">🦌</div><div className="absolute left-10 bottom-10 text-4xl">🎄</div><div className="absolute right-8 bottom-8 text-4xl">🔔</div>
      </div>
      <div className="relative w-[360px] max-w-[92vw]">
        <div className="mx-auto -mb-3 text-center"><div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/90 shadow"><Heart className="w-5 h-5 text-pink-500"/><span className="text-sm font-semibold text-gray-700">九宫格抽奖</span></div></div>
        <div className="rounded-3xl p-4 pt-6 bg-green-700 shadow-2xl border-4 border-green-800 relative">
          <div className="absolute inset-0 pointer-events-none rounded-3xl" style={{background:'radial-gradient(circle at 20px 20px, rgba(255,255,255,0.9) 2px, transparent 3px) 0 0/36px 36px, radial-gradient(circle at 20px 20px, rgba(255,255,255,0.6) 1px, transparent 2px) 18px 18px/36px 36px'}}/>
          <div className="relative grid grid-cols-3 gap-3 z-10">
            {Array.from({length:9}).map((_,i)=>{ const ringIdx=[0,1,2,5,8,7,6,3]; const active=ringIdx[idx]===i; const isCenter=i===4; return (
              <div key={i} className={`h-24 sm:h-28 rounded-2xl bg-white/95 border-2 ${active?'border-yellow-400 shadow-[0_0_0_3px_rgba(255,215,0,0.6)] scale-105':'border-white/70'} transition-all duration-150 flex items-center justify-center relative overflow-hidden`}>
                <div className="absolute inset-0 bg-gradient-to-br from-white/0 to-yellow-50/30"/>
                {isCenter ? (
                  <div className="relative flex items-center justify-center"><div className="absolute w-12 h-12 rounded-full bg-yellow-400/40 animate-ping"/><div className="w-12 h-12 rounded-full bg-gradient-to-br from-yellow-300 via-orange-400 to-pink-500 shadow-lg flex items-center justify-center text-2xl select-none">🎉</div></div>
                ) : (
                  <div className="relative w-full h-full flex items-center justify-center"><div className="absolute inset-0 flex items-center justify-center select-none" style={{opacity:0.9,fontSize:'38px'}}>{['🎄','🎁','🎅','🦌','🔔','⭐️','❄️','🧦','🍬'][i%9]}</div></div>
                )}
              </div>
            )})}
          </div>
        </div>
      </div>
    </motion.div>
  )
}