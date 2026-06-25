import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { useStore } from './store'

document.documentElement.setAttribute('data-mode', 'light')

// Expose store for Playwright tests and dev tooling
window.__bbpStore = useStore

ReactDOM.createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>)
