export interface PageAnalysis {
 url:string;
 issues:string[];
 score:number;
}

export function analyzePage(page:{url:string;title?:string}):PageAnalysis{
 const issues:string[]=[];

 if(!page.title){
  issues.push('MISSING_TITLE');
 }

 return {
  url:page.url,
  issues,
  score: issues.length ? 70 : 95
 };
}
