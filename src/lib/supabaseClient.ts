// src/lib/supabaseClient.ts
import { createClient } from '@supabase/supabase-js';

const url = (import.meta as any)?.env?.VITE_SUPABASE_URL as string || '';
const key = (import.meta as any)?.env?.VITE_SUPABASE_ANON_KEY as string || '';

// 开发期打印，方便定位
if (import.meta.env.DEV) {
  console.log('[Supabase 环境检查]', {
    hasURL: !!url,
    urlValue: url ? `${url.substring(0, 20)}...` : '未设置',
    anonKeyLen: key ? key.length : 0,
  });
  
  if (!url || !key) {
    console.warn('⚠️ Supabase 配置不完整！请检查 .env 文件中的:');
    console.warn('   VITE_SUPABASE_URL');
    console.warn('   VITE_SUPABASE_ANON_KEY');
  }
}

// ✅ 添加配置验证
if (!url || !key) {
  throw new Error(
    'Supabase 配置缺失！请在根目录创建 .env 文件并添加:\n' +
    'VITE_SUPABASE_URL=你的supabase项目URL\n' +
    'VITE_SUPABASE_ANON_KEY=你的anon密钥'
  );
}

export const supabase = createClient(url, key, {
  auth: { 
    persistSession: false 
  },
  // ✅ 添加更详细的错误日志
  global: {
    headers: {
      'X-Client-Info': 'wish-game-app',
    },
  },
});

// ✅ 测试连接
if (import.meta.env.DEV) {
  supabase
    .from('rooms')
    .select('count')
    .limit(1)
    .then(({ error }) => {
      if (error) {
        console.error('❌ Supabase 连接测试失败:', error.message);
        console.error('   请确认:');
        console.error('   1. URL 和 Key 是否正确');
        console.error('   2. 数据库表 rooms 是否已创建');
        console.error('   3. RLS 策略是否已配置');
      } else {
        console.log('✅ Supabase 连接成功！');
      }
    });
}