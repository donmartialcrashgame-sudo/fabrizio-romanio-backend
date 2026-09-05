const GEMINI_BASE='https://generativelanguage.googleapis.com/v1beta';
const GEMINI_MODEL=String(process.env.GEMINI_MODEL||'gemini-3.8-flash');

export function geminiConfigured(){return Boolean(String(process.env.GEMINI_API_KEY||'').trim());}

function sourceList(response){
  const chunks=response?.candidates?.[0]?.groundingMetadata?.groundingChunks||[];
  const seen=new Set();
  return chunks.map(c=>c?.web).filter(Boolean).map(s=>({title:s.title||s.uri,url:s.uri})).filter(s=>s.url&&!seen.has(s.url)&&seen.add(s.url)).slice(0,12);
}

export async function analyzeFootballNews({title,description='',channel='',published_at='',url='',type='football feature'}={}){
  const key=String(process.env.GEMINI_API_KEY||'').trim();
  if(!key){const e=new Error('GEMINI_API_KEY is not configured on the backend.');e.status=503;throw e;}
  const safeTitle=String(title||'Football news').slice(0,500);
  const safeDescription=String(description||'').slice(0,5000);
  const prompt=`You are the senior football intelligence writer for an independent football news website. Produce a very detailed, well-structured analysis of the football story below. Use Google Search grounding to research the latest reliable public information before answering.\n\nSTORY TYPE: ${type}\nHEADLINE: ${safeTitle}\nSOURCE CHANNEL: ${channel}\nPUBLISHED: ${published_at}\nVIDEO URL: ${url}\nSOURCE DESCRIPTION: ${safeDescription}\n\nYour response must be substantial and useful to a football fan. Cover, when relevant: an executive summary; exactly what is being reported; the people and clubs involved; recent background and timeline; current transfer/contract situation; what is confirmed versus reported or unconfirmed; reliable numbers/fees/dates only when supported; quotes only when you can verify them; tactical or sporting significance; likely next steps; competing reports or uncertainty; and what readers should watch next. Do not invent facts. If reliable sources disagree, explain the disagreement. Clearly label rumours and speculation. Do not claim to have watched the video unless its contents are available in the supplied text. Finish with a concise 'Bottom line' section. Use clear headings and paragraphs. This is journalism assistance, not an official statement from any club, player or journalist.`;
  const response=await fetch(`${GEMINI_BASE}/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':key},body:JSON.stringify({contents:[{role:'user',parts:[{text:prompt}]}],tools:[{google_search:{}}],generationConfig:{maxOutputTokens:7000}})});
  const data=await response.json().catch(()=>({}));
  if(!response.ok){const e=new Error(data?.error?.message||`Gemini returned ${response.status}`);e.status=response.status;e.gemini=data;throw e;}
  const text=data?.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('')?.trim()||'';
  if(!text)throw new Error('Gemini returned no analysis.');
  return {ok:true,model:GEMINI_MODEL,analysis:text,sources:sourceList(data),grounded:true,generated_at:new Date().toISOString()};
}

export function registerGeminiRoutes(app){
  app.get('/api/ai-status',(_req,res)=>res.json({configured:geminiConfigured(),model:GEMINI_MODEL,provider:'Google Gemini'}));
  app.post('/api/ai/news-analysis',async(req,res)=>{
    try{
      const body=req.body||{};
      if(!String(body.title||'').trim())return res.status(400).json({error:'News title is required.'});
      res.json(await analyzeFootballNews(body));
    }catch(e){console.error('Gemini news analysis error:',e.gemini||e.message);res.status(e.status||500).json({error:'Unable to generate the AI news analysis.',message:e.message});}
  });
}
