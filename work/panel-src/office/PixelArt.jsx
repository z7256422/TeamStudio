/* 人物与工位分层绘制；每种姿态有不同道具和动作，SVG 始终保持硬边像素。 */
function PixelEmployee({ seed, pose }) {
  const shirts = ['#527ab4', '#cb8055', '#519b8b', '#9470b4', '#bb9150'];
  const skin = ['#edbd99', '#d9a078', '#bb825f'][seed % 3], shirt = shirts[seed % shirts.length];
  const handsUp = ['celebrate', 'approval'].includes(pose), resting = ['coffee', 'paused', 'queued'].includes(pose);
  return <g className={`pixel-person pose-${pose}`}>
    <path d="M56 89H77V112H56Z" fill="#41445e"/><path d="M55 108H64V115H51V112H55ZM70 108H79V113H83V117H70Z" fill="#35394c"/>
    <path d="M53 69H80V96H53Z" fill={shirt}/><path d="M56 71H76V75H56Z" fill="#ffffff33"/>
    {handsUp ? <g className="pixel-arms"><path d="M47 52H54V78H47ZM79 50H86V77H79Z" fill={skin}/><path d="M46 66H55V82H46ZM78 65H87V81H78Z" fill={shirt}/></g>
      : <g className="pixel-arms"><path d={pose === 'thinking' ? 'M45 58H52V85H45ZM80 77H87V91H80Z' : 'M45 77H53V92H45ZM80 77H88V92H80Z'} fill={skin}/></g>}
    <g className="pixel-head"><path d="M53 43H80V69H53Z" fill={skin}/><path d={seed % 2 ? 'M51 42H80V49H83V62H78V53H72V49H58V54H51Z' : 'M51 41H81V50H76V54H72V49H58V56H51Z'} fill={seed % 3 ? '#51414c' : '#aa7956'}/><path d="M56 58H60V61H56ZM72 58H76V61H72Z" fill="#3e3448"/><path d="M63 65H70V67H63Z" fill="#9b655e"/>{seed % 3 === 0 && <path d="M54 55H63V63H54ZM69 55H78V63H69ZM62 57H70V59H62Z" fill="none" stroke="#544966" strokeWidth="2"/>}</g>
    {resting && <g className="pixel-cup"><path d="M79 80H91V94H79ZM90 83H95V90H90Z" fill="#faf0ce"/><path d="M81 80H89V83H81Z" fill="#8b655c"/><path className="pixel-steam" d="M83 67H85V76H83ZM89 64H91V74H89Z" fill="#fffaf0"/></g>}
    {pose === 'reading' && <g><path d="M41 78L66 83L92 77V96L66 102L41 96Z" fill="#6d927c"/><path d="M45 80L65 85V98L45 93ZM69 85L88 80V94L69 99Z" fill="#fff0cc"/></g>}
    {pose === 'repair' && <path d="M83 69H89V77H95V71H99V81H91V97H85V82H80V73H83Z" fill="#abb5c8"/>}
    {pose === 'writing' && <g><path d="M79 77H99V101H79Z" fill="#fff8e1"/><path d="M82 81H95V83H82ZM82 86H94V88H82ZM82 91H90V93H82Z" fill="#a494b2"/></g>}
  </g>;
}

function PixelDesk({ agentId, status, pose }) {
  const seed = [...agentId].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  pose ||= OFFICE_SCENES[status]?.[0] || (status === 'running' ? 'coding' : 'unknown');
  const atDesk = ['coding', 'building', 'tool', 'quiet', 'thinking', 'writing', 'offline', 'unknown'].includes(pose);
  const screen = ['failed', 'offline'].includes(pose) ? '#e5a7a0' : pose === 'celebrate' ? '#a6d7a8' : atDesk ? '#aedcd7' : '#bac8d4';
  return <svg className={`pixel-desk scene-${pose}`} viewBox="0 0 160 140" shapeRendering="crispEdges" aria-hidden="true">
    <path d="M17 124H144V132H17Z" fill="#7a627322"/>
    <g className="pixel-workstation"><path d="M15 68H145V92H137V112H130V92H31V112H23V92H15Z" fill="#795c64"/><path d="M15 64H145V88H15Z" fill="#c8906b"/><path d="M18 66H142V70H18Z" fill="#efbc8c"/>
      <path d="M71 25H125V61H71Z" fill="#4b4864"/><path d="M75 29H121V55H75Z" fill={screen}/><path d="M94 61H102V66H111V70H85V66H94Z" fill="#57516b"/>
      <g className="pixel-screen-lines" fill="#4c8490"><path d="M79 34H105V37H79ZM79 41H116V44H79ZM79 48H100V51H79Z"/></g>
      <path d="M70 74H120V81H70Z" fill="#f1e4cd"/><path className="pixel-keys" d="M74 76H113V78H74Z" fill="#9f99a9"/>
      <path d="M29 69H43V80H29Z" fill="#92b4bd"/><path d="M31 65H35V74H31ZM38 63H41V74H38Z" fill="#f8d487"/>
    </g>
    <g className={`pixel-employee-position ${atDesk ? 'at-desk' : 'off-desk'}`}><PixelEmployee seed={seed} pose={pose}/></g>
    {['thinking', 'quiet', 'queued', 'unknown'].includes(pose) && <g className="pixel-thought"><path d="M13 9H64V31H34V38H28V31H13Z" fill="#fff8ea" stroke="#b7a8c4" strokeWidth="2"/>{pose === 'thinking' ? <path d="M32 15H43V18H38V24H34V20H32ZM34 27H38V29H34Z" fill="#9477bb"/> : <g className="pixel-dots" fill="#a091b5"><path d="M23 18H28V23H23ZM36 18H41V23H36ZM49 18H54V23H49Z"/></g>}</g>}
    {pose === 'approval' && <g className="pixel-sign"><path d="M26 9H63V38H26Z" fill="#ffdf8d" stroke="#af8842" strokeWidth="3"/><path d="M43 14H47V27H43ZM43 30H47V34H43ZM43 40H47V57H43Z" fill="#987239"/></g>}
    {pose === 'celebrate' && <g className="pixel-confetti"><path d="M18 14H23V20H18ZM102 11H109V16H102ZM128 38H133V45H128Z" fill="#d780a0"/><path d="M37 4H43V10H37ZM114 27H121V32H114ZM7 40H13V45H7Z" fill="#e8be60"/><path d="M61 9H67V15H61ZM137 16H143V23H137Z" fill="#76b2a4"/><path d="M89 12L95 18L106 5L110 9L95 27L85 17Z" fill="#4e9c76"/></g>}
    {pose === 'failed' && <g className="pixel-distress"><path d="M24 6H65V32H44L38 39V32H24Z" fill="#d36b80"/><path d="M36 12L51 26M51 12L36 26" stroke="#fff3e6" strokeWidth="4"/><path d="M17 53H21V64H17Z" fill="#a8c6e0"/></g>}
    {pose === 'offline' && <g className="pixel-signal" fill="none" stroke="#bd9296" strokeWidth="3"><path d="M19 19H49M25 27H43M32 35H37M20 39L48 13"/></g>}
    {pose === 'building' && <g className="pixel-blocks"><path d="M8 49H19V60H8ZM20 49H31V60H20ZM14 37H25V48H14Z" fill="#88b3ae" stroke="#597f85" strokeWidth="2"/></g>}
    {pose === 'tool' && <g className="pixel-tool-orbit"><path d="M20 15H36V31H20ZM12 21H44V25H12ZM26 7H30V39H26Z" fill="#ab94c8"/><path d="M25 20H31V26H25Z" fill="#f7eacb"/></g>}
  </svg>;
}
function PixelPlant({ className = '' }) {
  return <svg className={`pixel-plant ${className}`} viewBox="0 0 28 44" shapeRendering="crispEdges" aria-hidden="true"><path d="M12 9H16V31H12Z" fill="#47765d"/><path d="M3 7H12V13H17V2H23V14H18V20H9V17H3Z" fill="#72a879"/><path d="M1 19H8V24H13V20H23V25H17V30H9V27H1Z" fill="#5d956b"/><path d="M5 30H23V34H21V43H7V34H5Z" fill="#bb806b"/><path d="M7 32H21V35H7Z" fill="#dfa185"/></svg>;
}
function PixelWindow() {
  return <svg className="pixel-window" viewBox="0 0 160 70" shapeRendering="crispEdges" aria-hidden="true"><path d="M0 0H160V66H0Z" fill="#665d79"/><path d="M5 5H155V60H5Z" fill="#b8d7db"/><path d="M5 42H19V27H35V44H42V20H62V45H73V33H89V44H101V23H126V37H140V29H155V60H5Z" fill="#9db8c9"/><g className="pixel-clouds"><path d="M15 13H38V18H15ZM97 10H125V16H97Z" fill="#e8f0e5"/></g><path d="M77 3H82V62H77ZM3 31H158V35H3Z" fill="#7b718a"/><path d="M0 62H160V70H0Z" fill="#cdbbb5"/></svg>;
}
function PixelCat() {
  return <svg className="pixel-cat" viewBox="0 0 40 28" shapeRendering="crispEdges" aria-hidden="true"><path d="M7 15H29V25H7ZM9 8H15V15H9ZM24 8H29V15H24Z" fill="#c8a17c"/><path d="M29 19H36V12H39V24H29Z" fill="#b68968"/><path d="M12 18H16V20H12ZM22 18H26V20H22Z" fill="#71595e"/><path className="pixel-cat-breath" d="M6 25H30V27H6Z" fill="#a58b7c"/></svg>;
}
