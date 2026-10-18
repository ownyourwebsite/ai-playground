"use client";
import { useEffect, useRef, useState } from 'react';

const THRESHOLD = 48;
export function isAtBottom(node: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>) {
  return node.scrollHeight - node.scrollTop - node.clientHeight <= 2;
}
export function isAwayFromLatest(node: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>) {
  return node.scrollHeight > node.clientHeight + THRESHOLD &&
    node.scrollHeight - node.scrollTop - node.clientHeight > THRESHOLD;
}

/** Follow real layout, not token counts or hidden tool arguments. */
export function useChatScroll() {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [away, setAway] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  useEffect(() => {
    const node = viewport.current, body = content.current;
    if (!node || !body) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (following.current) node.scrollTop = node.scrollHeight;
      const offscreen = isAwayFromLatest(node);
      if (!offscreen) following.current = true;
      setAway(offscreen);
      setAtBottom(isAtBottom(node));
    };
    const resize = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const onScroll = () => {
      following.current = !isAwayFromLatest(node);
      setAway(!following.current);
      setAtBottom(isAtBottom(node));
    };
    const pause = () => {
      // Intent alone does not imply there are hidden messages. The actual scroll
      // event/next layout measurement decides whether to show the button.
      if (node.scrollHeight > node.clientHeight + THRESHOLD) following.current = false;
    };
    const wheel = (event: WheelEvent) => { if (event.deltaY < 0) pause(); };
    const key = (event: KeyboardEvent) => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) && event.target === node) pause();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(body); observer.observe(node);
    node.addEventListener('scroll', onScroll, { passive: true });
    node.addEventListener('wheel', wheel, { passive: true });
    node.addEventListener('touchmove', pause, { passive: true });
    node.addEventListener('keydown', key);
    resize();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect();
      node.removeEventListener('scroll', onScroll);
      node.removeEventListener('wheel', wheel);
      node.removeEventListener('touchmove', pause);
      node.removeEventListener('keydown', key);
    };
  }, []);
  const latest = () => {
    following.current = true; setAway(false); setAtBottom(true);
    if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  };
  return { viewport, content, away, atBottom, latest };
}
