import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';
import 'leaflet/dist/leaflet.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/*
      The app is not always served from "/". GitHub Pages hosts a project site
      at /<repo>/, and without a basename the router sees that prefix as an
      unknown route and renders its own 404 - while every asset loads fine, so
      the build looks healthy. Vite exposes the configured base as BASE_URL;
      locally it is "/" and this changes nothing.
    */}
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
