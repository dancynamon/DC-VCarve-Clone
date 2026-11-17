// ---- dock icon set ---------------------------------------------------------------
// Full-colour 48x48 pictures, one per command. Each shows what the command DOES: the CAM icons
// are a cut through real material with the actual cutter in it, the CAD icons the shape with its
// grab points. Outlines use --ic-ink so they follow light / dark mode; fills come from the shared
// gradients injected by ICON_DEFS. Every button also gets a text label (see paintIcons).
const IG=n=>'url(#ig-'+n+')';
const ICON_GRADS={ blue:['#7cc0f5','#2b7cc9'], sky:['#e0f0fd','#a6cff2'], green:['#7fdca6','#23955b'], amber:['#ffdc7a','#e9a321'],
  red:['#f7968a','#d33a2e'], purple:['#c4a9f0','#7a4fc9'], teal:['#74dad4','#14918c'], steel:['#f2f5f8','#8f9dad'], slate:['#a7b6c7','#5c6f84'],
  wood:['#e9c48a','#bd8a47'], woodtop:['#f8e6c4','#e7c78f'], paper:['#ffffff','#dce6f0'], skin:['#ffe0b8','#f0b478'], dark:['#6b4c2e','#3f2b18'] };
const ICON_DEFS='<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute" aria-hidden="true"><defs>'+
  Object.keys(ICON_GRADS).map(n=>'<linearGradient id="ig-'+n+'" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="'+ICON_GRADS[n][0]+'"/><stop offset="1" stop-color="'+ICON_GRADS[n][1]+'"/></linearGradient>').join('')+
  '</defs></svg>';
const ICON_SVG=(inner,size)=>'<svg class="ic" viewBox="0 0 48 48" width="'+(size||34)+'" height="'+(size||34)+'" fill="none" stroke="var(--ic-ink)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+inner+'</svg>';

// drawing primitives
const iP=(d,f,x)=>'<path d="'+d+'"'+(f?' fill="'+f+'"':'')+(x?' '+x:'')+'/>';
const iR=(x,y,w,h,f,e)=>'<rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'"'+(f?' fill="'+f+'"':'')+(e?' '+e:'')+'/>';
const iC=(x,y,r,f,e)=>'<circle cx="'+x+'" cy="'+y+'" r="'+r+'"'+(f?' fill="'+f+'"':'')+(e?' '+e:'')+'/>';
const iT=(x,y,s,f,t)=>'<text x="'+x+'" y="'+y+'" font-size="'+s+'" font-family="system-ui,Arial,sans-serif" font-weight="800" text-anchor="middle" fill="'+f+'" stroke="none">'+t+'</text>';
const iH=(x,y)=>iR(x-2.8,y-2.8,5.6,5.6,'#fff','rx="1" stroke="#d9820a" stroke-width="1.7"');   // a grab point on a shape
const iO=(x,y)=>iC(x,y,3,'#fff','stroke="#d9820a" stroke-width="1.7"');                         // a curve control handle
const iDash='stroke-dasharray="3.4 3"';
const iLine=(d,c,w,e)=>iP(d,'','stroke="'+c+'" stroke-width="'+(w||2.4)+'"'+(e?' '+e:''));
const iBadge=(x,y,c,mark)=>iC(x,y,9.5,IG(c),'stroke="#fff" stroke-width="1.6"')+iLine(mark,'#fff',3);
const iPlus=(x,y)=>iBadge(x,y,'green','M'+(x-5)+' '+y+' H'+(x+5)+' M'+x+' '+(y-5)+' V'+(y+5));
// cutters, drawn with the tip at (x, tip)
const iEndmill=(x,tip,top,w)=>{ top=top==null?2:top; w=w||10; return iR(x-w/2,top,w,tip-top,IG('steel'),'rx="1.5"')+iLine('M'+(x-w/2)+' '+(tip-5)+' L'+(x+w/2)+' '+(tip-11)+' M'+(x-w/2)+' '+(tip-12)+' L'+(x+w/2)+' '+(tip-18),'var(--ic-ink)',1.3); };
const iVbit=(x,tip,hw,h,top)=>{ top=top==null?2:top; return iR(x-4.5,top,9,tip-h-top,IG('steel'),'rx="1.2"')+iP('M'+(x-hw)+' '+(tip-h)+' H'+(x+hw)+' L'+x+' '+tip+'Z',IG('steel')); };
const iDoc=iP('M9 4 H30 L40 14 V45 H9 Z',IG('paper'))+iP('M30 4 V14 H40',IG('sky'));
const iTag=(c,t)=>iR(4,25,33,15,IG(c),'rx="2.5"')+iT(20.5,36.6,11,'#fff',t);
const iFloppy=iP('M6 6 H36 L42 12 V42 H6 Z',IG('blue'))+iR(15,6,16,11,IG('steel'))+iR(28,8,3,7,'var(--ic-ink)','stroke="none"')+iR(13,26,22,16,IG('paper'))+iLine('M17 31 H31 M17 36.5 H31','var(--ic-ink)',1.4);
const iClip=iR(9,8,30,37,IG('paper'),'rx="3"')+iR(17,3,14,9,IG('slate'),'rx="2"')+iLine('M15 20 H33 M15 26 H27','#7f90a4',2);
const iAlign=(guide,dash,a,b)=>iR(a[0],a[1],a[2],a[3],IG('blue'),'rx="1.6"')+iR(b[0],b[1],b[2],b[3],IG('amber'),'rx="1.6"')+iLine(guide,'#d33a2e',3,dash?iDash:'');
const iThree=(s,c,t)=>iR(s[0],s[1],16,16,IG('blue'),'rx="2"')+iC(c[0],c[1],8,IG('green'))+iP('M'+t[0]+' '+t[1]+' l9 15 h-18 Z',IG('amber'));
const iCircles=iC(17,24,13,'','opacity=".55"')+iC(31,24,13,'','opacity=".55"');
const iArrowR=(x,y,len,c)=>iLine('M'+x+' '+y+' H'+(x+len)+' M'+(x+len-4.5)+' '+(y-4.5)+' L'+(x+len)+' '+y+' L'+(x+len-4.5)+' '+(y+4.5),c||'#23955b',3);

const ICONS={
  // ---- select and view ----
  select:  iR(17,15,27,27,'rgba(43,124,201,.12)','stroke="#2b7cc9" '+iDash)+iP('M6 4 V33 L13.6 26.4 L18.8 38 L24.6 35.4 L19.4 23.8 H29 Z',IG('blue')),
  pan:     iP('M16 25 V12 a3.2 3.2 0 0 1 6.4 0 V23 V8.5 a3.2 3.2 0 0 1 6.4 0 V23 V11 a3.2 3.2 0 0 1 6.4 0 V25 V16 a3.2 3.2 0 0 1 6.4 0 V32 c0 8 -6 13 -13.5 13 c-6.5 0 -9.5 -2.5 -13 -8 L7.5 29 c-2 -3.5 2.5 -6.5 5.5 -4 Z',IG('skin')),
  measure: iLine('M6 7 V19 M42 7 V19','#2b7cc9',2.4)+iLine('M7 13 H41 M12 8.6 L7 13 L12 17.4 M36 8.6 L41 13 L36 17.4','#2b7cc9',2.4)+iR(3,24,42,17,IG('amber'),'rx="2"')+iP('M10 24 V32 M17 24 V36 M24 24 V32 M31 24 V36 M38 24 V32'),
  fit:     iLine('M5 15 V5 H15 M33 5 H43 V15 M43 33 V43 H33 M15 43 H5 V33','#2b7cc9',3.2)+iP('M24 11 L28 20 L37 20.6 L30 26.6 L32.4 36 L24 31 L15.6 36 L18 26.6 L11 20.6 L20 20 Z',IG('amber')),
  fitjob:  iLine('M4 13 V4 H13 M35 4 H44 V13 M44 35 V44 H35 M13 44 H4 V35','#2b7cc9',3.2)+iR(11,13,26,22,IG('wood')),
  // ---- draw shapes ----
  rect:    iR(6,11,36,26,IG('blue'))+iH(6,11)+iH(42,11)+iH(6,37)+iH(42,37),
  rrect:   iR(6,11,36,26,IG('blue'),'rx="9"')+iLine('M6 20 A9 9 0 0 1 15 11','#ffdc7a',3.4)+iH(15,11)+iH(6,20),
  circle:  iC(24,24,19,IG('blue'))+iLine('M24 24 L37.4 10.6','#fff',2.2)+iC(24,24,2.4,'#fff','stroke="none"')+iH(37.4,10.6),
  ellipse: iP('M3 24 a21 13.5 0 1 0 42 0 a21 13.5 0 1 0 -42 0 Z',IG('blue'))+iLine('M3 24 H45 M24 10.5 V37.5','#fff',1.6,iDash)+iH(45,24)+iH(24,10.5),
  polygon: iP('M24 4 L41.5 14 V34 L24 44 L6.5 34 V14 Z',IG('blue'))+iH(24,4)+iH(41.5,14)+iH(41.5,34)+iH(24,44)+iH(6.5,34)+iH(6.5,14),
  star:    iP('M24 3.5 L30.2 17.2 L45 18.8 L34 28.8 L37.2 43.5 L24 36 L10.8 43.5 L14 28.8 L3 18.8 L17.8 17.2 Z',IG('amber')),
  // ---- draw lines and text ----
  line:    iLine('M9 39 L39 9','#2b7cc9',4)+iH(9,39)+iH(39,9),
  polyline:iLine('M6 40 L16 15 L30 31 L42 8','#2b7cc9',3.6)+iH(6,40)+iH(16,15)+iH(30,31)+iH(42,8),
  bezier:  iLine('M6 39 L13 11 M42 31 L33 9','#8c9cb0',1.7)+iLine('M6 39 C13 11 33 9 42 31','#2b7cc9',3.8)+iH(6,39)+iH(42,31)+iO(13,11)+iO(33,9),
  arc:     iLine('M24 37 L6 33 M24 37 L42 33','#8c9cb0',1.7,iDash)+iLine('M6 33 A18.6 18.6 0 0 1 42 33','#2b7cc9',4)+iC(24,37,2.6,'#d33a2e','stroke="none"')+iH(6,33)+iH(42,33),
  text:    '<text x="24" y="37" font-size="33" font-family="Georgia,\'Times New Roman\',serif" font-weight="700" text-anchor="middle" fill="url(#ig-blue)" stroke="var(--ic-ink)" stroke-width="1">Aa</text>',
  dim:     iP('M6 22 V44 M42 22 V44')+iLine('M8 36 H40 M13.5 31.4 L8 36 L13.5 40.6 M34.5 31.4 L40 36 L34.5 40.6','#d33a2e',2.4)+iR(11,6,26,17,IG('paper'),'rx="2"')+iT(24,19,12.5,'#d33a2e','2.50'),
  // ---- move, copy, layout ----
  mirrorh: iP('M20 9 V39 H4 Z',IG('blue'))+iP('M28 9 V39 H44 Z','rgba(43,124,201,.2)','stroke="#2b7cc9" '+iDash)+iLine('M24 3 V45','#d33a2e',2.6,iDash),
  mirrorv: iP('M9 20 H39 V4 Z',IG('blue'))+iP('M9 28 H39 V44 Z','rgba(43,124,201,.2)','stroke="#2b7cc9" '+iDash)+iLine('M3 24 H45','#d33a2e',2.6,iDash),
  rotate:  iR(12,20,20,20,'','stroke="#8c9cb0" '+iDash)+iR(14,18,20,20,IG('blue'),'transform="rotate(24 24 28)"')+iLine('M8 16 A21 21 0 0 1 40 16','#23955b',3.2)+iLine('M40 8 L40.6 16.4 L32.4 15.6','#23955b',3.2),
  rot90:   iR(9,18,26,26,IG('blue'),'rx="2"')+iT(22,35.5,12.5,'#fff','90&#176;')+iLine('M9 11 A17 17 0 0 1 39 21','#23955b',3.2)+iLine('M33.4 18.2 L39.4 22 L43 16','#23955b',3.2),
  duplicate:iR(4,4,27,27,IG('sky'),'rx="3"')+iR(14,14,30,30,IG('blue'),'rx="3"')+iLine('M29 22 V36 M22 29 H36','#fff',3.4),
  array:   [[4,4,'amber'],[18,4,'blue'],[32,4,'blue'],[4,18,'blue'],[18,18,'blue'],[32,18,'blue'],[4,32,'blue'],[18,32,'blue'],[32,32,'blue']].map(c=>iR(c[0],c[1],12,12,IG(c[2]),'rx="2"')).join(''),
  nest:    iR(3,5,42,38,IG('wood'))+iR(7,9,16,13,IG('blue'),'rx="1.5"')+iC(34,16,8,IG('green'))+iP('M7 26 H26 V39 H7 Z',IG('amber'))+iP('M30 39 L37 26 L44 39 Z',IG('red'),'transform="translate(-2 0)"'),
  // ---- edit ----
  node:    iLine('M5 37 C13 7 31 7 43 27','#2b7cc9',3.4)+iH(5,37)+iH(43,27)+iR(19.5,10.5,8,8,IG('amber'),'rx="1.2"')+iP('M27 21 V43 L32.4 38.6 L36 46 L40 44.2 L36.4 37 H43 Z',IG('paper')),
  fillet:  iLine('M8 42 V8 H42','#8c9cb0',2.2,iDash)+iLine('M8 42 V27 A19 19 0 0 1 27 8 H42','#2b7cc9',4.2)+iLine('M27 27 L14 14 M14 21 V14 H21','#d9820a',2.6)+iC(27,27,2.6,'#d9820a','stroke="none"'),
  trim:    iLine('M9 4 L33 32','var(--ic-ink)',4.6)+iLine('M39 4 L15 32','var(--ic-ink)',4.6)+iLine('M9.6 4.6 L32.6 31.4','#cdd6df',2.2)+iLine('M38.4 4.6 L15.4 31.4','#cdd6df',2.2)+iC(11,38,7,'#fff','stroke="#d33a2e" stroke-width="4"')+iC(37,38,7,'#fff','stroke="#d33a2e" stroke-width="4"'),
  extend:  iR(38,4,7,40,IG('slate'),'rx="1.5"')+iLine('M4 24 H20','#2b7cc9',4.4)+iLine('M20 24 H34','#23955b',3.4,iDash)+iLine('M28.4 17.6 L35 24 L28.4 30.4','#23955b',3.4)+iH(4.5,24),
  join:    iLine('M4 42 C13 42 13 27 21 27','#2b7cc9',3.8)+iLine('M44 42 C35 42 35 27 27 27','#23955b',3.8)+iLine('M7 11 H17 M13 6.6 L17.6 11 L13 15.4 M41 11 H31 M35 6.6 L30.4 11 L35 15.4','#d9820a',3)+iC(24,27,5.4,IG('amber'))+iH(4.5,42)+iH(43.5,42),
  offset:  iR(4,5,40,38,'','rx="9" stroke="#d9820a" stroke-width="2.6" '+iDash)+iR(14,15,20,18,IG('blue'),'rx="2"')+iLine('M34 24 H43 M39.2 20 L43.4 24 L39.2 28','#23955b',2.6),
  fitcurves:iLine('M4 37 L10 24 L16 31 L22 15 L29 22 L35 11 L44 15','#a3afbd',2.2)+iLine('M4 39 C15 12 30 29 44 9','#2b7cc9',4)+iH(4,39)+iH(44,9),
  validate:iP('M24 3.5 L41.5 10 V24 C41.5 34.5 33 41.5 24 45 C15 41.5 6.5 34.5 6.5 24 V10 Z',IG('green'))+iLine('M14.5 24 L21.5 31.5 L34 16.5','#fff',4.4),
  del:     iP('M11 14 L13.4 45 H34.6 L37 14 Z',IG('red'))+iR(5,8.5,38,6,IG('slate'),'rx="2"')+iP('M18 8.5 V4 H30 V8.5')+iLine('M19 21 V38 M24 21 V38 M29 21 V38','#fff',2.2),
  // ---- combine ----
  group:   iR(3,3,42,42,'rgba(217,130,10,.1)','stroke="#d9820a" stroke-width="2.4" '+iDash)+iThree([9,9],[32,17],[21,27])+iH(3,3)+iH(45,3)+iH(3,45)+iH(45,45),
  ungroup: iThree([3,3],[37,11],[24,29])+iLine('M23 20 L9 34 M9 26.6 V34 H16.4','#d33a2e',3),
  weld:    iP('M24 13.05 A13 13 0 1 1 24 34.95 A13 13 0 1 1 24 13.05 Z',IG('green'))+iLine('M24 13.05 A13 13 0 0 0 24 34.95','#fff',1.6,iDash),
  subtract:iC(31,24,13,'','stroke="#d33a2e" stroke-width="2.2" '+iDash)+iP('M24 13.05 A13 13 0 1 0 24 34.95 A13 13 0 0 1 24 13.05 Z',IG('blue')),
  intersect:iCircles+iP('M24 13.05 A13 13 0 0 1 24 34.95 A13 13 0 0 1 24 13.05 Z',IG('amber')),
  // ---- align ----
  alignL:  iAlign('M6 3 V45',0,[11,9,31,12],[11,27,19,12]),
  alignHC: iAlign('M24 3 V45',1,[8,9,32,12],[14,27,20,12]),
  alignR:  iAlign('M42 3 V45',0,[6,9,31,12],[18,27,19,12]),
  alignT:  iAlign('M3 6 H45',0,[9,11,12,31],[27,11,12,19]),
  alignVC: iAlign('M3 24 H45',1,[9,8,12,32],[27,14,12,20]),
  alignB:  iAlign('M3 42 H45',0,[9,6,12,31],[27,18,12,19]),
  // ---- file ----
  'new':   iDoc+iPlus(35.5,36.5),
  open:    iP('M4 41 V8 H18 L23 13 H41 V21',IG('amber'))+iP('M4 41 L11 21 H47 L40 41 Z',IG('amber')),
  save:    iFloppy,
  saveas:  iFloppy+iP('M27 46 L28.6 38.4 L41 26 L47 32 L34.6 44.4 Z',IG('amber'),'stroke="#fff" stroke-width="1.5"'),
  tracebmp:iR(3,5,29,25,IG('sky'),'rx="2"')+iP('M3 28 L13 15 L20 23 L25 18 L32 26 V30 H3 Z',IG('green'),'stroke="none"')+iC(25,11,3,IG('amber'),'stroke="none"')+iLine('M13 43 C25 43 36 37 44 18','#7a4fc9',3.8)+iH(13,43)+iH(44,18)+iO(33,36),
  expdxf:  iDoc+iTag('red','DXF')+iArrowR(30,41,15),
  expsvg:  iDoc+iTag('purple','SVG')+iArrowR(30,41,15),
  // ---- job, output, templates, clipart ----
  setup:   iR(13,5,32,29,IG('wood'))+iLine('M13 41 H43 M38.5 36.6 L43 41 L38.5 45.4','#d33a2e',2.8)+iLine('M5 34 V5 M.6 9.5 L5 5 L9.4 9.5','#23955b',2.8)+iC(13,34,3.6,'#d33a2e','stroke="#fff" stroke-width="1.4"'),
  preview: iP('M2.5 24 C12 7 36 7 45.5 24 C36 41 12 41 2.5 24 Z',IG('sky'))+iC(24,24,10.5,IG('blue'))+iC(24,24,4.4,'#14324f','stroke="none"')+iC(27.4,20.6,2.2,'#fff','stroke="none"'),
  post:    iDoc+iTag('green','TAP')+iArrowR(30,41,15),
  tplapply:iClip+iP('M18 30 L18 42 L30 36 Z',IG('green')),
  tplsave: iClip+iPlus(35.5,36.5),
  tpldel:  iClip+iBadge(35.5,36.5,'red','M31.5 32.5 L39.5 40.5 M39.5 32.5 L31.5 40.5'),
  'export':iLine('M6 31 V43 H42 V31','#5c6f84',3.4)+iLine('M24 34 V6 M14 15 L24 5 L34 15','#23955b',4),
  'import':iLine('M6 31 V43 H42 V31','#5c6f84',3.4)+iLine('M24 5 V33 M14 24 L24 34 L34 24','#2b7cc9',4),
  clipadd: iP('M21 3.5 L26.4 15.4 L39.4 16.8 L29.8 25.6 L32.6 38.4 L21 31.8 L9.4 38.4 L12.2 25.6 L2.6 16.8 L15.6 15.4 Z',IG('amber'))+iPlus(36.5,37),
  // ---- toolpath operations: the material, the cutter, and the cut it leaves ----
  profile: iR(3,12,42,34,IG('wood'))+iR(13,22,20,15,IG('woodtop'),'rx="2"')+iR(8.5,17.5,29,24,'','rx="5" stroke="#d33a2e" stroke-width="3" '+iDash)+iEndmill(37.5,23,1,9),
  pocket:  iP('M3 20 H12 V34 H36 V20 H45 V46 H3 Z',IG('wood'))+iEndmill(24,34,2,13)+iLine('M4 29 H10 M38 29 H44','#a97a3b',1.3),
  drill:   iP('M3 20 H45 V46 H3 Z',IG('wood'))+iR(9,20,8,20,IG('dark'))+iR(29,20,8,20,IG('dark'))+iR(29,3,8,25,IG('steel'),'rx="1"')+iP('M29 28 H37 L33 37 Z',IG('steel'))+iLine('M29 11 L37 7 M29 18 L37 14 M29 25 L37 21','var(--ic-ink)',1.3),
  vcarve:  iP('M3 22 H12 L24 41 L36 22 H45 V46 H3 Z',IG('wood'))+iVbit(24,40,11,17),
  engrave: iR(3,15,42,31,IG('woodtop'))+iLine('M9 40 L17 22 L25 40 M12.4 33.5 H21.6','#6b4c2e',3.4)+iLine('M25 40 C30 40 35 37 37 32','#d33a2e',2.2,iDash)+iVbit(37,31,6.5,13,1),
  inlay:   iP('M3 28 H13 L18 40 H30 L35 28 H45 V46 H3 Z',IG('wood'))+iP('M12 4 H36 L30 18 H18 Z',IG('purple'))+iLine('M24 20 V33 M19.6 28.6 L24 33 L28.4 28.6','#23955b',3.2),
  chamfer: iP('M3 20 H28 L43 35 V46 H3 Z',IG('wood'))+iLine('M28 20 L43 35','#d33a2e',3.4)+iVbit(36,29,10,15,2),
  fluting: iR(4,4,40,40,IG('wood'))+[13,24,35].map(x=>iP('M'+x+' 8 Q'+(x+5.6)+' 24 '+x+' 40 Q'+(x-5.6)+' 24 '+x+' 8 Z',IG('dark'),'stroke-width="1"')).join(''),
  prism:   iP('M5 7 H43 L30 24 H18 Z',IG('woodtop'))+iP('M43 7 V41 L30 24 Z',IG('wood'))+iP('M5 41 H43 L30 24 H18 Z',IG('dark'))+iP('M5 7 V41 L18 24 Z',IG('amber'))+iLine('M18 24 H30','var(--ic-ink)',2.4),
  moulding:iP('M4 44 V27 C10 27 10 17 16 17 C20 17 20 12 24 12 V44 Z',IG('wood'))+iP('M4 27 C10 27 10 17 16 17 C20 17 20 12 24 12 L44 4 C40 4 40 9 36 9 C30 9 30 19 24 19 L4 27 Z',IG('woodtop'))+iP('M24 12 L44 4 V36 L24 44 Z',IG('dark'),'opacity=".9"'),
};
