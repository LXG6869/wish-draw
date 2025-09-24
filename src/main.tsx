import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import WishGameWithRooms from './WishGameWithRooms'  // ✅ 确保导入的是这个组件

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WishGameWithRooms />
  </React.StrictMode>,
)
