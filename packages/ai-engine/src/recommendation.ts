export interface Recommendation {
 type:string;
 priority:number;
 confidence:number;
 risk:number;
 message:string;
}

export function createRecommendation(type:string):Recommendation{
 return {
  type,
  priority:90,
  confidence:85,
  risk:10,
  message:'Improve existing SEO asset safely.'
 };
}
