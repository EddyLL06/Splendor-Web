import ReactDOM from 'react-dom/client';

import App from './App.js';
import { AuthProvider } from './auth.js';
import './i18n.js';
import './styles/app.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <AuthProvider><App /></AuthProvider>,
);
