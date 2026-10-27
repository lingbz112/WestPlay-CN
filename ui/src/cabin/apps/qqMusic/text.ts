import type { Strings } from '../../state/strings'
import { useText as useCabinText } from '../../state/text'

export { useLanguage } from '../../state/text'

/**
 * The copied Apple Music app's words, with the few service names changed. The layout, pages and
 * animations stay Apple Music's until the QQ-specific pages replace them.
 */
export function useText(): Strings {
  const text = useCabinText()
  return {
    ...text,
    appleMusic: {
      ...text.appleMusic,
      signIn: 'Sign in',
      promptTitle: 'Sign in to QQ Music',
      finishOnPc: 'Finish signing in on your PC: QQ Music’s sign-in is open in a window on your desktop.',
      cantPlay: 'QQ Music can’t play this right now.',
      homePitch: {
        ...text.appleMusic.homePitch,
        title: 'Get more from QQ Music',
      },
    },
  }
}
