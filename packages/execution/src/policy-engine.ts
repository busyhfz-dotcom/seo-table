import { SeoAction } from './types';

export function canExecute(
  action: SeoAction,
  mode: 'INVISIBLE' | 'FULL_AUTOPILOT'
) {
  const safeActions = [
    'META_TITLE',
    'META_DESCRIPTION',
    'CANONICAL',
    'SCHEMA'
  ];

  if (mode === 'INVISIBLE') {
    return safeActions.includes(action.type);
  }

  return true;
}
