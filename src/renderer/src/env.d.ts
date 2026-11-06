import type { ButlerApi } from '../../preload/index'

declare global {
  interface Window {
    butler: ButlerApi
  }
}

export {}
