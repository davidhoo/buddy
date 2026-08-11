// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Switch } from '../../../src/renderer/components/Switch'

afterEach(cleanup)

describe('Switch', () => {
  it('reports switch state and sends the inverse value when clicked', () => {
    const onChange = vi.fn()
    render(<Switch checked ariaLabel="立即执行" onChange={onChange} />)

    const control = screen.getByRole('switch', { name: '立即执行' })
    expect(control).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(control)
    expect(onChange).toHaveBeenCalledWith(false)
  })

  it('reports unchecked state and sends true when clicked', () => {
    const onChange = vi.fn()
    render(<Switch checked={false} ariaLabel="排队执行" onChange={onChange} />)

    const control = screen.getByRole('switch', { name: '排队执行' })
    expect(control).toHaveAttribute('aria-checked', 'false')

    fireEvent.click(control)
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('does not keep internal state between toggles', () => {
    const onChange = vi.fn()
    render(<Switch checked ariaLabel="开关" onChange={onChange} />)

    const control = screen.getByRole('switch', { name: '开关' })
    fireEvent.click(control)
    fireEvent.click(control)

    expect(onChange).toHaveBeenNthCalledWith(1, false)
    expect(onChange).toHaveBeenNthCalledWith(2, false)
    expect(control).toHaveAttribute('aria-checked', 'true')
  })
})
