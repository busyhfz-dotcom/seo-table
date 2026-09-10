export * from './types';
export * from './policy-engine';

export type SeoMode = 'INVISIBLE' | 'FULL_OPTIMIZATION';

export type ActionType =
 | 'META_TITLE'
 | 'META_DESCRIPTION'
 | 'CANONICAL'
 | 'SCHEMA';

export function canExecute(
 action: ActionType,
 mode: SeoMode
){
 if(mode === 'INVISIBLE'){
  return [
   'META_TITLE',
   'META_DESCRIPTION',
   'CANONICAL',
   'SCHEMA'
  ].includes(action);
 }

 return true;
}
