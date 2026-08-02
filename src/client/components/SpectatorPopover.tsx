import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import type { PublicRoomState } from '../../shared/types/room.js';

export function SpectatorPopover({ room }: { room: PublicRoomState }) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 12, left: 12 });
  const popoverID = useId();

  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current?.getBoundingClientRect();
    const popover = popoverRef.current?.getBoundingClientRect();
    if (!trigger || !popover) return;
    setPosition({
      top: Math.max(
        8,
        trigger.bottom + popover.height + 8 <= window.innerHeight
          ? trigger.bottom + 8
          : trigger.top - popover.height - 8,
      ),
      left: Math.max(
        8,
        Math.min(window.innerWidth - popover.width - 8, trigger.right - popover.width),
      ),
    });
    closeRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !popoverRef.current?.contains(target)
      ) {
        close(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  const popover =
    open && typeof document !== 'undefined'
      ? createPortal(
          <div className="spectator-popover-layer">
            <div
              ref={popoverRef}
              id={popoverID}
              className="spectator-popover"
              role="dialog"
              aria-label={t('spectators.title')}
              style={{ top: position.top, left: position.left }}
            >
              <div className="spectator-popover-heading">
                <strong>{t('spectators.title')}</strong>
                <button
                  ref={closeRef}
                  type="button"
                  className="icon-button spectator-close"
                  aria-label={t('common.close')}
                  onClick={() => close()}
                >
                  ×
                </button>
              </div>
              {room.spectators.length > 0 ? (
                <ul className="spectator-list">
                  {room.spectators.map((spectator, index) => (
                    <li key={`${spectator.username}-${index}`}>
                      <span aria-hidden="true">●</span>
                      <strong>{spectator.username}</strong>
                      {spectator.isViewer && <small>{t('common.you')}</small>}
                      {spectator.isHost && <small>{t('waiting.host')}</small>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="empty-copy">{t('spectators.empty')}</p>
              )}
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <span className="spectator-control">
      <button
        ref={triggerRef}
        type="button"
        className="button button-ghost button-small spectator-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={popoverID}
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true">👁</span>{' '}
        {room.spectatorCount} / {room.spectatorCapacity}
      </button>
      {popover}
    </span>
  );
}
