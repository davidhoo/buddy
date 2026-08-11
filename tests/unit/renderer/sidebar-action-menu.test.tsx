// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SidebarActionMenu,
  SidebarMenuItem,
  SidebarMenuDivider,
  type SidebarMenuAnchor
} from '../../../src/renderer/components/SidebarActionMenu'

function mockMenuSize(width: number, height: number) {
  // jsdom returns zero-sized rects by default; give the menu real dimensions so
  // the positioning algorithm can clamp against the viewport.
  const original = Element.prototype.getBoundingClientRect
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.getAttribute('role') === 'menu') {
      return { width, height, x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, toJSON: () => ({}) } as DOMRect
    }
    return original.call(this)
  })
}

function renderMenu(anchor: SidebarMenuAnchor, onClose = vi.fn()) {
  render(
    <SidebarActionMenu anchor={anchor} onClose={onClose}>
      <SidebarMenuItem onSelect={() => {}}>Item</SidebarMenuItem>
      <SidebarMenuDivider />
    </SidebarActionMenu>
  )
  return onClose
}

describe('SidebarActionMenu', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true, writable: true })
    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true, writable: true })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders into document.body via portal with role="menu"', () => {
    mockMenuSize(160, 80)
    renderMenu({ x: 100, y: 100, align: 'left' })

    const menu = screen.getByRole('menu')
    expect(menu).toBeInTheDocument()
    expect(document.body.contains(menu)).toBe(true)
  })

  it('calls onClose once when Escape is pressed', () => {
    mockMenuSize(160, 80)
    const onClose = renderMenu({ x: 100, y: 100, align: 'left' })

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on outside click but not on inside click', () => {
    mockMenuSize(160, 80)
    const onClose = renderMenu({ x: 100, y: 100, align: 'left' })

    fireEvent.mouseDown(screen.getByRole('menu'))
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.mouseDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on window blur, capture-phase scroll, and resize', () => {
    mockMenuSize(160, 80)
    const onClose = renderMenu({ x: 100, y: 100, align: 'left' })

    act(() => window.dispatchEvent(new Event('blur')))
    expect(onClose).toHaveBeenCalledTimes(1)

    act(() => window.dispatchEvent(new Event('scroll')))
    expect(onClose).toHaveBeenCalledTimes(2)

    act(() => window.dispatchEvent(new Event('resize')))
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('clamps a bottom-right anchor inside the viewport', () => {
    mockMenuSize(200, 120)
    renderMenu({ x: 1000, y: 700, align: 'right' })

    const menu = screen.getByRole('menu')
    const left = parseInt(menu.style.left, 10)
    const top = parseInt(menu.style.top, 10)

    // Right-aligned at x=1000 with width 200 → initial left 800; within [8, 816] so stays 800.
    expect(left).toBe(800)
    // Bottom overflow → flip up: 700-120=580; within [8, 640] so stays 580.
    expect(top).toBe(580)
    expect(left + 200).toBeLessThanOrEqual(window.innerWidth)
    expect(top + 120).toBeLessThanOrEqual(window.innerHeight)
  })

  it('clamps a left-aligned anchor overflowing the right edge', () => {
    mockMenuSize(200, 80)
    renderMenu({ x: 1000, y: 100, align: 'left' })

    const menu = screen.getByRole('menu')
    const left = parseInt(menu.style.left, 10)
    // Left-aligned at x=1000 → initial left 1000; clamp to 1024-200-8=816.
    expect(left).toBe(816)
    expect(left + 200).toBeLessThanOrEqual(window.innerWidth)
  })
})
