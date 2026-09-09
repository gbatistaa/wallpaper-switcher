'use client';

import { useState, useEffect, useRef } from 'react';
import { Toaster, toast } from 'sonner';

export default function Home() {
  const [images, setImages] = useState([]);
  const [config, setConfig] = useState({ timer_hours: 2, timer_minutes: 0, timer_mode: 'interval', jpeg_quality: 80, max_width: 3840 });
  const [loading, setLoading] = useState(false);
  const [timerActive, setTimerActive] = useState(false);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [nextTrigger, setNextTrigger] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [nowTick, setNowTick] = useState(() => new Date());
  const [dragOver, setDragOver] = useState(false);
  const [previewMedia, setPreviewMedia] = useState(null);
  const [booted, setBooted] = useState(false);

  // applyTimer roda num setTimeout; o closure capturaria 'config' antigo.
  // Um ref sempre aponta para a ultima config commitada (evita agendar
  // com o preset anterior, ex: clicou 2h mas usou 1h).
  const configRef = useRef(config);
  useEffect(() => { configRef.current = config; });

  useEffect(() => {
    loadData();
    const timer = setTimeout(() => setBooted(true), 800);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const timer = setInterval(async () => {
      const api = window.api;
      if (!api) return;
      const status = await api.getTimerStatus();
      setTimerActive(status.active);
      setNextTrigger(status);
    }, 15000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNowTick(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  async function loadData() {
    const api = window.api;
    if (!api) return;
    const [imgs, cfg, timer] = await Promise.all([
      api.getImages(), api.getConfig(), api.getTimerStatus()
    ]);
    setImages(imgs);
    setConfig(cfg);
    setTimerActive(timer.active);
    setNextTrigger(timer);
  }

  async function handleAdd() {
    const api = window.api;
    const files = await api.selectFiles();
    if (!files || files.length === 0) return;
    setLoading(true);
    let photoCount = 0;
    for (const file of files) {
      const id = toast.loading(`COMPRIMINDO: ${file.split('/').pop()}`);
      await api.addImage(file);
      toast.dismiss(id);
      photoCount++;
    }
    toast.success(`INJETADO: ${photoCount} FOTO(S)`);
    await loadData();
    setLoading(false);
  }

  async function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    const api = window.api;
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    setLoading(true);
    let photoCount = 0;
    for (const file of files) {
      const filePath = file.path || file.webkitRelativePath || file.name;
      if (file.type.startsWith('image/')) {
        await api.addImage(filePath);
        photoCount++;
      }
    }
    if (photoCount > 0) toast.success(`INJETADO: ${photoCount} FOTO(S)`);
    await loadData();
    setLoading(false);
  }

  async function handleRemove() {
    if (!pendingDelete) return;
    const api = window.api;
    setDeleteBusy(true);
    try {
      await api.removeMedia(pendingDelete.id);
    } finally {
      setDeleteBusy(false);
    }
    setPendingDelete(null);
    toast.success('ARQUIVO DELETADO');
    await loadData();
  }

  async function handleSetWallpaper() {
    const api = window.api;
    setLoading(true);
    const id = toast.loading('RENDERIZANDO WALLPAPER...');
    const result = await api.setWallpaper();
    toast.dismiss(id);
    if (result.success) {
      toast.success('WALLPAPER ATIVADO');
    } else {
      toast.error('FALHA: ' + result.output);
    }
    await loadData();
    setLoading(false);
  }

  async function handleToggleTimer() {
    const api = window.api;
    if (toggleBusy) return;
    const target = !timerActive;
    setToggleBusy(true);
    setTimerActive(target);
    let result;
    try {
      result = await api.toggleTimer(target);
    } catch (err) {
      result = null;
    }
    setToggleBusy(false);
    if (result && result.ok) {
      setTimerActive(result.active);
      setNextTrigger(result);
      toast.success(target ? 'TIMER ONLINE' : 'TIMER OFFLINE');
    } else {
      setTimerActive(!target);
      toast.error('ERRO: backend não respondeu, timer inalterado.');
    }
  }

  const applyTimerRef = useRef(null);

  // Fuso so na interface: config guarda o horario em UTC (modo diario).
  // Conversao local<->UTC usando o offset descoberto pelo backend.
  function tzOffsetHours() {
    return Math.round(((nextTrigger && nextTrigger.tzOffsetSeconds) || 0) / 3600);
  }

  function localToUtcH(localH) {
    return (((parseInt(localH) || 0) - tzOffsetHours()) % 24 + 24) % 24;
  }

  function utcToLocalH(utcH) {
    return (((parseInt(utcH) || 0) + tzOffsetHours()) % 24 + 24) % 24;
  }

  function applyTimer() {
    if (applyTimerRef.current) clearTimeout(applyTimerRef.current);
    applyTimerRef.current = setTimeout(async () => {
      const api = window.api;
      const cur = configRef.current || config;
      // A base (relogio da interface) e o governo e o python calcula em UTC naive.
      const baseMs = Date.now();
      const result = await api.updateTimer(cur.timer_hours, cur.timer_minutes, cur.timer_mode, baseMs);
      if (result && result.next) {
        setTimerActive(result.active);
        setNextTrigger(result);
      }
    }, 600);
  }

  function formatNext(stat) {
    if (!stat || !stat.next) return '';
    const n = stat.next;
    const off = stat.tzOffsetSeconds ?? 0;
    const t = new Date(Date.UTC(n.year, n.month - 1, n.day, n.hour, n.minute, 0) + off * 1000);
    const dd = String(t.getUTCDate()).padStart(2, '0');
    const mo = String(t.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = t.getUTCFullYear();
    const hh = String(t.getUTCHours()).padStart(2, '0');
    const mi = String(t.getUTCMinutes()).padStart(2, '0');
    return `${dd}/${mo}/${yyyy} ${hh}:${mi}`;
  }

  function minutesUntil(stat) {
    if (!stat || !stat.next) return null;
    const n = stat.next;
    const off = stat.tzOffsetSeconds ?? 0;
    const ms = Date.UTC(n.year, n.month - 1, n.day, n.hour, n.minute, 0) + off * 1000 - Date.now();
    return Math.max(0, Math.round(ms / 60000));
  }

  function formatSize(bytes) {
    return (bytes / 1024 / 1024).toFixed(1) + 'MB';
  }

  function p2(n) {
    return String(n).padStart(2, '0');
  }

  function formatClock(d) {
    return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  }

  function formatDateBR(d) {
    return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()}`;
  }

  function openPreview(item) {
    setPreviewMedia(item.thumbnail);
  }

  const paddingPresets = [
    { h: 0, m: 30, l: '30M' },
    { h: 1, m: 0, l: '1H' },
    { h: 2, m: 0, l: '2H' },
    { h: 6, m: 0, l: '6H' },
    { h: 12, m: 0, l: '12H' },
  ];

  const totalMedia = images.length;

  return (
    <div
      style={{ minHeight: '100vh', fontFamily: "'Rajdhani', sans-serif", position: 'relative' }}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {/* Background layers */}
      <div className="cyber-grid-bg" />
      <div className="cyber-particles" />
      <div className="cyber-scanline" />

      {/* Drag overlay */}
      {dragOver && (
        <div className="cyber-drag-overlay">
          <div style={{ fontFamily: 'Orbitron', fontWeight: 700, fontSize: 22, color: 'var(--neon-cyan)', letterSpacing: 4, textShadow: '0 0 20px rgba(0,255,255,0.5)' }}>
            INJECT DATA
          </div>
          <div style={{ fontFamily: 'Share Tech Mono', fontSize: 13, color: 'var(--text-secondary)', marginTop: 8 }}>
            SOLTE FOTOS OU VIDEOS PARA ADICIONAR AO STORAGE
          </div>
        </div>
      )}

      <Toaster
        theme="dark"
        position="bottom-right"
        toastOptions={{
          style: {
            background: 'linear-gradient(135deg, #0d1233, #0a0e27)',
            border: '1px solid rgba(0, 255, 255, 0.2)',
            color: '#e8e8f0',
            fontFamily: "'Share Tech Mono', monospace",
            fontSize: '12px',
            clipPath: 'polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)',
          },
        }}
      />

      {/* Preview modal */}
      {previewMedia && (
        <div className="cyber-modal-bg" onClick={() => { setPreviewMedia(null); }}>
          <img src={previewMedia} alt="" />
        </div>
      )}

      {/* Main content */}
      <div style={{ position: 'relative', zIndex: 2, maxWidth: 1150, margin: '0 auto', padding: '32px 28px' }}>
        {/* ███ TITLE BAR (system style frame:false) ███ */}
        <div className="titlebar">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <img
              src="/omnitrix.png"
              alt=""
              style={{ width: 18, height: 18, borderRadius: 3, objectFit: 'cover', flexShrink: 0 }}
              onError={(e) => (e.currentTarget.style.display = 'none')}
            />
            <span style={{ fontFamily: 'Orbitron', fontWeight: 600, fontSize: 12, letterSpacing: 2, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
              WALLPAPER_<span style={{ color: 'var(--neon-cyan)' }}>SYS</span>
            </span>
          </div>

          <div className="titlebar-clock" style={{ marginLeft: 'auto', marginRight: 12 }}>
            <span style={{ color: 'var(--neon-cyan)', textShadow: '0 0 8px rgba(0,255,255,0.5)' }}>{formatClock(nowTick)}</span>
            <span style={{ color: 'var(--text-dim)', fontSize: 10 }}>{formatDateBR(nowTick)}</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
            <button className="tb-btn" onClick={() => window.api && window.api.minimize()} title="Minimizar" aria-label="Minimizar">
              <svg width="12" height="12" viewBox="0 0 12 12"><line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" strokeWidth="1.4" /></svg>
            </button>
            <button className="tb-btn" onClick={() => window.api && window.api.maximize()} title="Maximizar" aria-label="Maximizar">
              <svg width="12" height="12" viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
            </button>
            <button className="tb-btn tb-close" onClick={() => window.api && window.api.close()} title="Fechar" aria-label="Fechar">
              <svg width="12" height="12" viewBox="0 0 12 12"><line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" strokeWidth="1.4" /><line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" strokeWidth="1.4" /></svg>
            </button>
          </div>
        </div>

        {/* ███ HEADER ███ */}
        <div style={{ marginBottom: 28, animation: 'slideInUp 0.5s ease' }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <div style={{ fontFamily: 'Share Tech Mono', fontSize: 11, color: 'var(--neon-green)', letterSpacing: 3, marginBottom: 4 }}>
                &gt; SYSTEM_INIT v1.0.0
              </div>
              <h1 style={{
                fontFamily: 'Orbitron', fontWeight: 900, fontSize: 30, letterSpacing: 2,
                color: 'var(--neon-cyan)', textShadow: '0 0 10px rgba(0,255,255,0.4), 0 0 40px rgba(0,255,255,0.15)',
                margin: 0, textTransform: 'uppercase',
              }}>
                WALLPAPER<span style={{ color: 'var(--neon-magenta)', textShadow: '0 0 10px rgba(255,0,255,0.4), 0 0 40px rgba(255,0,255,0.15)' }}>_SYS</span>
              </h1>
            </div>

            {/* Stats */}
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
              <div className="cyber-stat">
                <span style={{ color: 'var(--neon-magenta)' }}>&#9673;</span>
                <span className="num">{images.length}</span>
                FOTOS
              </div>
              <div className="cyber-stat">
                <span style={{ color: 'var(--neon-green)' }}>SUM</span>
                <span className="num">{totalMedia}</span>
                TOTAL
              </div>
            </div>
          </div>
          <div className="cyber-divider" style={{ marginTop: 16 }} />
        </div>

        {/* ███ ACTION BAR ███ */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap', animation: 'slideInUp 0.6s ease' }}>
          <button className="cyber-btn" onClick={handleAdd} disabled={loading} style={{ flexShrink: 0 }}>
            + INJECT DATA
          </button>
          <button
            className="cyber-btn magenta"
            onClick={handleSetWallpaper}
            disabled={loading || totalMedia === 0}
            style={{ flexShrink: 0 }}
          >
            &#9654; RENDER NOW
          </button>

          {/* Timer status badge */}
          <div style={{
            marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8,
            fontFamily: "'Share Tech Mono', monospace", fontSize: 11,
            padding: '6px 14px', border: '1px solid var(--border-neon)', background: 'var(--bg-deep)',
            alignSelf: 'center',
          }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%', display: 'inline-block',
              background: timerActive ? 'var(--neon-green)' : 'var(--neon-pink)',
              boxShadow: timerActive ? '0 0 8px var(--neon-green)' : '0 0 8px var(--neon-pink)',
              animation: timerActive ? 'neonPulse 2s ease infinite' : 'none',
            }} />
            <span style={{ color: timerActive ? 'var(--neon-green)' : 'var(--neon-pink)' }}>
              {timerActive ? 'TIMER: ONLINE' : 'TIMER: OFFLINE'}
            </span>
            {nextTrigger && timerActive && (
              <span style={{ color: 'var(--text-dim)' }}>NEXT: {formatNext(nextTrigger)} {minutesUntil(nextTrigger) !== null && <span style={{ color: 'var(--neon-green)' }}>(EM {minutesUntil(nextTrigger)}MIN)</span>}</span>
            )}
            {nextTrigger && nextTrigger.tzName && (
              <span style={{ color: 'var(--text-dim)', fontSize: 10 }}>({nextTrigger.tzName})</span>
            )}
          </div>
        </div>

        {/* ███ TIMER PANEL ███ */}
        <div className="cyber-card cyber-corners" style={{ padding: '18px 22px', marginBottom: 20, animation: 'slideInUp 0.7s ease' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            {/* Timer toggle */}
            <button
              className={`cyber-toggle ${timerActive ? 'active' : ''}`}
              onClick={handleToggleTimer}
              disabled={toggleBusy}
              aria-label="Toggle timer"
            >
              <span className="knob" />
              {toggleBusy && <span className="toggle-busy" />}
            </button>

            <span style={{ fontFamily: 'Orbitron', fontWeight: 600, fontSize: 13, letterSpacing: 2, color: 'var(--text-primary)' }}>
              TIMER_FREQ
            </span>

            {/* Mode selector */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button
                className={`cyber-chip ${config.timer_mode !== 'daily' ? 'active' : ''}`}
                onClick={() => {
                  // Voltando de diario: o numero exibido era LOCAL -> vira o intervalo.
                  setConfig({ ...config, timer_mode: 'interval', timer_hours: config.timer_mode === 'daily' ? utcToLocalH(config.timer_hours) : config.timer_hours });
                  applyTimer();
                }}
              >
                INTERVALO
              </button>
              <button
                className={`cyber-chip ${config.timer_mode === 'daily' ? 'active' : ''}`}
                onClick={() => {
                  // Indo para diario: horas digitadas sao LOCAIS -> guarda UTC.
                  setConfig({ ...config, timer_mode: 'daily', timer_hours: config.timer_mode === 'daily' ? config.timer_hours : localToUtcH(config.timer_hours) });
                  applyTimer();
                }}
              >
                1X AO DIA
              </button>
            </div>

            {config.timer_mode !== 'daily' ? (
              <>
                {/* Hour input */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="number"
                    className="cyber-input"
                    min={0}
                    max={23}
                    value={config.timer_hours}
                    onChange={(e) => { setConfig({ ...config, timer_hours: parseInt(e.target.value) || 0 }); applyTimer(); }}
                  />
                  <span style={{ fontFamily: 'Share Tech Mono', fontSize: 12, color: 'var(--text-secondary)' }}>H</span>
                </div>

                {/* Minute input */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="number"
                    className="cyber-input"
                    min={0}
                    max={59}
                    value={config.timer_minutes}
                    onChange={(e) => { setConfig({ ...config, timer_minutes: parseInt(e.target.value) || 0 }); applyTimer(); }}
                  />
                  <span style={{ fontFamily: 'Share Tech Mono', fontSize: 12, color: 'var(--text-secondary)' }}>MIN</span>
                </div>

                {/* Presets */}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {paddingPresets.map(p => (
                    <button
                      key={p.l}
                      className={`cyber-chip ${config.timer_hours === p.h && config.timer_minutes === p.m ? 'active' : ''}`}
                      onClick={() => { setConfig({ ...config, timer_hours: p.h, timer_minutes: p.m }); applyTimer(); }}
                    >
                      {p.l}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                {/* Daily hour (input local; config guarda UTC) */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="number"
                    className="cyber-input"
                    min={0}
                    max={23}
                    value={utcToLocalH(config.timer_hours)}
                    onChange={(e) => { setConfig({ ...config, timer_hours: localToUtcH(e.target.value) }); applyTimer(); }}
                  />
                  <span style={{ fontFamily: 'Share Tech Mono', fontSize: 12, color: 'var(--text-secondary)' }}>H</span>
                </div>

                {/* Daily minute */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="number"
                    className="cyber-input"
                    min={0}
                    max={59}
                    value={config.timer_minutes}
                    onChange={(e) => { setConfig({ ...config, timer_minutes: parseInt(e.target.value) || 0 }); applyTimer(); }}
                  />
                  <span style={{ fontFamily: 'Share Tech Mono', fontSize: 12, color: 'var(--text-secondary)' }}>MIN</span>
                </div>
              </>
            )}
          </div>
        </div>

        {/* ███ PHOTOS SECTION ███ */}
        {images.length > 0 && (
          <div style={{ marginBottom: 28, animation: 'slideInUp 1s ease' }}>
            <div className="cyber-section-header">
              <span style={{ color: 'var(--neon-cyan)', textShadow: '0 0 8px rgba(0,255,255,0.4)', fontSize: 16 }}>&#9632;</span>
              <span className="neon-text-cyan">PHOTO_BUFFER [{String(images.length).padStart(2, '0')}]</span>
              <span className="line" />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 14 }}>
              {images.map((img, idx) => (
                <div
                  key={img.id}
                  className="cyber-card"
                  style={{
                    cursor: 'pointer',
                    animation: `slideInUp 0.5s ease ${idx * 0.04}s both`,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(0,255,255,0.5)'; e.currentTarget.style.boxShadow = '0 0 15px rgba(0,255,255,0.15)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(0,255,255,0.15)'; e.currentTarget.style.boxShadow = 'none'; }}
                >
                  <div className="cyber-img-wrap" style={{ height: 140, background: 'var(--bg-deep)', cursor: 'pointer' }}
                    onClick={() => openPreview(img)}>
                    <img
                      src={img.thumbnail}
                      alt={img.original_name}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      onError={(e) => { e.target.style.display = 'none'; }}
                    />
                  </div>
                  <div style={{ padding: '10px 12px' }}>
                    <div style={{
                      fontFamily: "'Share Tech Mono', monospace", fontSize: 11,
                      color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {img.original_name}
                    </div>
                    <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 10, color: 'var(--text-dim)', marginTop: 4, display: 'flex', justifyContent: 'space-between' }}>
                      <span>{formatSize(img.compressed_size)}</span>
                      <span style={{ color: 'var(--text-dim)' }}>ORIG: {formatSize(img.original_size)}</span>
                    </div>
                  </div>
                  <button
                    className="cyber-delete"
                    disabled={deleteBusy}
                    onClick={(e) => { e.stopPropagation(); setPendingDelete(img); }}
                  >
                    x
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ███ EMPTY STATE ███ */}
        {totalMedia === 0 && (
          <div className="cyber-empty cyber-corners" style={{ padding: 60, textAlign: 'center', animation: 'glitchIn 0.5s ease' }}>
            <div style={{ fontSize: 40, color: 'var(--neon-cyan)', textShadow: '0 0 20px rgba(0,255,255,0.4)', animation: 'neonPulse 2s ease infinite' }}>
              [ EMPTY ]
            </div>
            <div style={{ fontFamily: 'Orbitron', fontWeight: 600, fontSize: 16, color: 'var(--neon-cyan)', letterSpacing: 2, marginTop: 16 }}>
              STORAGE_BUFFER: 0 BYTES
            </div>
            <div style={{ fontFamily: 'Share Tech Mono', fontSize: 13, color: 'var(--text-dim)', marginTop: 8 }}>
              &gt; INICIAR TRANSFERENCIA: ARRASTE ARQUIVOS OU USE &lt;INJECT_DATA&gt;
            </div>
            <div className="cyber-terminal" style={{ marginTop: 16 }}>
              <span className="prompt">&gt;</span> <span className="cmd">wallpaper_sys --status</span><br />
              <span className="prompt">&gt;</span> no_media_found. awaiting_input<span className="cursor-blink" />
            </div>
          </div>
        )}

        {/* ███ DELETE CONFIRM MODAL ███ */}
        {pendingDelete && (
          <div
            style={{
              position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(3,4,14,0.85)', backdropFilter: 'blur(3px)', animation: 'glitchIn 0.25s ease',
            }}
            onClick={() => !deleteBusy && setPendingDelete(null)}
          >
            <div
              className="cyber-card cyber-corners"
              style={{
                maxWidth: 420, width: '100%', margin: '0 16px', padding: '26px 28px',
                border: '1px solid rgba(255,0,128,0.5)',
                boxShadow: '0 0 35px rgba(255,0,128,0.25), inset 0 0 25px rgba(255,0,128,0.05)',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                <span style={{ color: 'var(--neon-pink)', fontSize: 18, textShadow: '0 0 10px rgba(255,0,128,0.5)' }}>&#9888;</span>
                <span style={{ fontFamily: 'Orbitron', fontWeight: 600, fontSize: 13, letterSpacing: 2, color: 'var(--neon-pink)' }}>
                  CONFIRM_DELETE
                </span>
              </div>
              {pendingDelete.thumbnail && (
                <div style={{ marginBottom: 14, overflow: 'hidden', border: '1px solid rgba(255,0,128,0.35)', boxShadow: 'inset 0 0 18px rgba(255,0,128,0.08)' }}>
                  <img
                    src={pendingDelete.thumbnail}
                    alt={pendingDelete.original_name}
                    style={{ width: '100%', height: 120, objectFit: 'cover', display: 'block' }}
                    onError={(e) => { e.target.style.display = 'none'; }}
                  />
                </div>
              )}
              <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.7 }}>
                Deletar permanentemente o arquivo:
                <br />
                <span style={{ color: 'var(--neon-cyan)' }}>&gt; {pendingDelete.original_name}</span>
                <br />
                <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>Essa ação não pode ser desfeita.</span>
              </div>
              <div style={{ display: 'flex', gap: 12, marginTop: 22, justifyContent: 'flex-end' }}>
                <button className="cyber-btn" onClick={() => setPendingDelete(null)} disabled={deleteBusy} style={{ padding: '9px 18px', fontSize: 11 }}>
                  CANCELAR
                </button>
                <button className="cyber-btn magenta" onClick={handleRemove} disabled={deleteBusy} style={{ padding: '9px 18px', fontSize: 11 }}>
                  {deleteBusy ? 'DELETANDO...' : 'DELETAR'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ███ FOOTER TERMINAL ███ */}
        <div style={{ marginTop: 12, padding: '14px 20px', border: '1px solid var(--border-neon)', background: 'rgba(6,9,26,0.5)', fontFamily: "'Share Tech Mono', monospace", fontSize: 11 }}>
          <div style={{ color: 'var(--neon-green)' }}>&gt; SYS.LOG: wallpaper_switcher v1.0.0 :: MODE=PHOTOS :: {totalMedia} FILES INDEXED</div>
          <div style={{ color: 'var(--text-dim)', marginTop: 4 }}>
            &gt; [C]YBER-[P]UNK_ENGINE_ENABLED :: TIMER={timerActive ? 'ACTIVE' : 'STANDBY'}
            <span className="cursor-blink" style={{ marginLeft: 8 }} />
          </div>
        </div>
      </div>
    </div>
  );
}
