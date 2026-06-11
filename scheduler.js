import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
)

const OPENROUTER_KEY = process.env.OPENROUTER_KEY

// Equipos del Mundial 2026 por grupo
const WC_GROUPS = {
  A: ['Mexico', 'South Africa', 'South Korea'],
  B: ['Canada', 'Switzerland', 'Qatar'],
  C: ['Brazil', 'Morocco', 'Haiti', 'Scotland'],
  D: ['USA', 'Paraguay', 'Australia'],
  E: ['Germany', 'Curacao', 'Ivory Coast', 'Ecuador'],
  F: ['Netherlands', 'Japan', 'Tunisia'],
  G: ['Belgium', 'Egypt', 'Iran', 'New Zealand'],
  H: ['Spain', 'Cape Verde', 'Saudi Arabia', 'Uruguay'],
  I: ['France', 'Senegal', 'Norway'],
  J: ['Argentina', 'Algeria', 'Austria', 'Jordan'],
  K: ['Portugal', 'Colombia', 'Uzbekistan'],
  L: ['England', 'Croatia', 'Ghana', 'Panama']
}

async function log(action, matchId, details) {
  await supabase.from('wc_scheduler_logs').insert({
    action, match_id: matchId, details,
    created_at: new Date().toISOString()
  })
  console.log(`[${new Date().toISOString()}] ${action} ${matchId || ''} — ${details}`)
}

async function searchWebStats(homeTeam, awayTeam, minute) {
  const query = minute > 0
    ? `FIFA World Cup 2026 ${homeTeam} vs ${awayTeam} live score stats minute ${minute} possession shots xG`
    : `FIFA World Cup 2026 ${homeTeam} vs ${awayTeam} today preview odds lineup`

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'HTTP-Referer': 'https://edgeiq.app',
        'X-Title': 'EDGEIQ Scheduler'
      },
      body: JSON.stringify({
        model: 'perplexity/sonar',
        max_tokens: 600,
        messages: [
          {
            role: 'system',
            content: `You are a live football data extractor for the FIFA World Cup 2026.
Extract ONLY real data in this exact JSON format:
{
  "home_score": 0,
  "away_score": 0,
  "minute": 0,
  "status": "live|finished|scheduled",
  "home_possession": 50,
  "away_possession": 50,
  "home_shots": 0,
  "away_shots": 0,
  "home_shots_on_target": 0,
  "away_shots_on_target": 0,
  "home_xg": 0.0,
  "away_xg": 0.0,
  "home_corners": 0,
  "away_corners": 0,
  "home_yellow_cards": 0,
  "away_yellow_cards": 0,
  "home_red_cards": 0,
  "away_red_cards": 0,
  "summary": "brief text summary"
}
If data not available, use 0 for numbers and "unknown" for status.
RETURN ONLY THE JSON, NO OTHER TEXT.`
          },
          {
            role: 'user',
            content: query
          }
        ]
      })
    })

    const data = await res.json()
    const content = data.choices?.[0]?.message?.content || '{}'
    const clean = content.replace(/```json|```/g, '').trim()
    return JSON.parse(clean)
  } catch (e) {
    console.error('Web search error:', e.message)
    return null
  }
}

async function upsertMatch(matchId, homeTeam, awayTeam, groupName, webData) {
  const matchData = {
    match_id: matchId,
    home_team: homeTeam,
    away_team: awayTeam,
    home_score: webData?.home_score || 0,
    away_score: webData?.away_score || 0,
    status: webData?.status || 'scheduled',
    minute: webData?.minute || 0,
    group_name: groupName,
    updated_at: new Date().toISOString()
  }

  const { error } = await supabase
    .from('wc_matches')
    .upsert(matchData, { onConflict: 'match_id' })

  if (error) console.error('Match upsert error:', error.message)
  return matchData
}

async function saveMatchStats(matchId, homeTeam, awayTeam, webData, minute) {
  if (!webData) return

  // Stats del equipo local
  await supabase.from('wc_match_stats').insert({
    match_id: matchId,
    team: homeTeam,
    possession_pct: webData.home_possession || 50,
    shots_total: webData.home_shots || 0,
    shots_on_target: webData.home_shots_on_target || 0,
    xg: webData.home_xg || 0,
    corners: webData.home_corners || 0,
    yellow_cards: webData.home_yellow_cards || 0,
    red_cards: webData.home_red_cards || 0,
    snapshot_minute: minute,
    raw_data: JSON.stringify(webData),
    created_at: new Date().toISOString()
  })

  // Stats del equipo visitante
  await supabase.from('wc_match_stats').insert({
    match_id: matchId,
    team: awayTeam,
    possession_pct: webData.away_possession || 50,
    shots_total: webData.away_shots || 0,
    shots_on_target: webData.away_shots_on_target || 0,
    xg: webData.away_xg || 0,
    corners: webData.away_corners || 0,
    yellow_cards: webData.away_yellow_cards || 0,
    red_cards: webData.away_red_cards || 0,
    snapshot_minute: minute,
    raw_data: JSON.stringify(webData),
    created_at: new Date().toISOString()
  })
}

async function updateTeamProfile(teamName, groupName, matchData, isHome, webData) {
  if (!webData || webData.status !== 'finished') return

  const myScore = isHome ? webData.home_score : webData.away_score
  const rivalScore = isHome ? webData.away_score : webData.home_score
  const won = myScore > rivalScore ? 1 : 0
  const drawn = myScore === rivalScore ? 1 : 0
  const lost = myScore < rivalScore ? 1 : 0

  // Traer perfil existente
  const { data: existing } = await supabase
    .from('wc_team_profiles')
    .select('*')
    .eq('team_name', teamName)
    .single()

  if (existing) {
    // Actualizar acumulando
    const mp = existing.matches_played + 1
    await supabase.from('wc_team_profiles').update({
      matches_played: mp,
      wins: existing.wins + won,
      draws: existing.draws + drawn,
      losses: existing.losses + lost,
      goals_for: existing.goals_for + myScore,
      goals_against: existing.goals_against + rivalScore,
      avg_possession: ((existing.avg_possession * existing.matches_played) + (isHome ? webData.home_possession : webData.away_possession)) / mp,
      avg_shots: ((existing.avg_shots * existing.matches_played) + (isHome ? webData.home_shots : webData.away_shots)) / mp,
      avg_xg: ((existing.avg_xg * existing.matches_played) + (isHome ? webData.home_xg : webData.away_xg)) / mp,
      clean_sheets: rivalScore === 0 ? existing.clean_sheets + 1 : existing.clean_sheets,
      last_match_date: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).eq('team_name', teamName)
  } else {
    // Crear perfil nuevo
    await supabase.from('wc_team_profiles').insert({
      team_name: teamName,
      group_name: groupName,
      matches_played: 1,
      wins: won,
      draws: drawn,
      losses: lost,
      goals_for: myScore,
      goals_against: rivalScore,
      avg_possession: isHome ? webData.home_possession : webData.away_possession,
      avg_shots: isHome ? webData.home_shots : webData.away_shots,
      avg_xg: isHome ? webData.home_xg : webData.away_xg,
      clean_sheets: rivalScore === 0 ? 1 : 0,
      last_match_date: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
  }
}

async function getTodayMatches() {
  // Buscar partidos de hoy en Supabase
  const today = new Date().toISOString().split('T')[0]
  const { data } = await supabase
    .from('wc_matches')
    .select('*')
    .gte('match_date', today + 'T00:00:00Z')
    .lte('match_date', today + 'T23:59:59Z')

  return data || []
}

async function checkLiveMatches() {
  // Buscar partidos en vivo en Supabase
  const { data } = await supabase
    .from('wc_matches')
    .select('*')
    .eq('status', 'live')

  return data || []
}

// Partidos conocidos del Mundial para inicializar
// (el scheduler los busca automáticamente si no están)
const KNOWN_TODAY_MATCHES = [
  { matchId: 'wc2026-001', home: 'Mexico', away: 'South Africa', group: 'A' },
]

async function main() {
  console.log('🌍 EDGEIQ World Cup Tracker iniciando...')
  await log('SCHEDULER_START', null, `Run at ${new Date().toISOString()}`)

  try {
    // 1. Verificar partidos en vivo primero
    const liveMatches = await checkLiveMatches()

    if (liveMatches.length > 0) {
      console.log(`⚽ ${liveMatches.length} partido(s) en vivo detectado(s)`)

      for (const match of liveMatches) {
        console.log(`Actualizando: ${match.home_team} vs ${match.away_team} (min ${match.minute})`)

        const webData = await searchWebStats(match.home_team, match.away_team, match.minute)

        if (webData) {
          await upsertMatch(match.match_id, match.home_team, match.away_team, match.group_name, webData)
          await saveMatchStats(match.match_id, match.home_team, match.away_team, webData, webData.minute || match.minute)

          // Si terminó, actualizar perfiles
          if (webData.status === 'finished') {
            await updateTeamProfile(match.home_team, match.group_name, match, true, webData)
            await updateTeamProfile(match.away_team, match.group_name, match, false, webData)
            await log('MATCH_FINISHED', match.match_id, `${match.home_team} ${webData.home_score}-${webData.away_score} ${match.away_team}`)
          } else {
            await log('MATCH_UPDATED', match.match_id, `Min ${webData.minute}: ${webData.home_score}-${webData.away_score} | Summary: ${webData.summary}`)
          }
        }
      }
    } else {
      // 2. Buscar si hay partido hoy que arrancar
      console.log('Verificando partidos de hoy...')

      const todayMatches = await getTodayMatches()

      // Si no hay partidos registrados hoy, buscar en la web
      if (todayMatches.length === 0) {
        console.log('Buscando partidos del Mundial de hoy en la web...')

        const searchRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENROUTER_KEY}`,
            'HTTP-Referer': 'https://edgeiq.app',
            'X-Title': 'EDGEIQ'
          },
          body: JSON.stringify({
            model: 'perplexity/sonar',
            max_tokens: 400,
            messages: [{
              role: 'user',
              content: `What FIFA World Cup 2026 matches are being played today ${new Date().toLocaleDateString('en-US')}? Return JSON array: [{"home":"TeamA","away":"TeamB","time":"HH:MM UTC","group":"X"}]. Only today's matches. Return ONLY JSON.`
            }]
          })
        })

        const searchData = await searchRes.json()
        const content = searchData.choices?.[0]?.message?.content || '[]'
        const clean = content.replace(/```json|```/g, '').trim()

        try {
          const matches = JSON.parse(clean)
          console.log(`Encontrados ${matches.length} partidos hoy`)

          for (const m of matches) {
            const matchId = `wc2026-${m.home.replace(/\s/g,'-').toLowerCase()}-vs-${m.away.replace(/\s/g,'-').toLowerCase()}`
            const group = Object.entries(WC_GROUPS).find(([g, teams]) =>
              teams.some(t => t.toLowerCase().includes(m.home.toLowerCase())) ||
              teams.some(t => t.toLowerCase().includes(m.away.toLowerCase()))
            )?.[0] || m.group || 'A'

            await supabase.from('wc_matches').upsert({
              match_id: matchId,
              home_team: m.home,
              away_team: m.away,
              status: 'scheduled',
              group_name: group,
              match_date: new Date().toISOString(),
              updated_at: new Date().toISOString()
            }, { onConflict: 'match_id' })

            await log('MATCH_REGISTERED', matchId, `${m.home} vs ${m.away} Grupo ${group}`)
          }
        } catch (e) {
          console.log('No se pudieron parsear partidos:', e.message)
        }
      } else {
        // Verificar si alguno de los partidos de hoy está por empezar o en vivo
        for (const match of todayMatches) {
          if (match.status === 'scheduled') {
            const webData = await searchWebStats(match.home_team, match.away_team, 0)
            if (webData && (webData.status === 'live' || webData.minute > 0)) {
              await upsertMatch(match.match_id, match.home_team, match.away_team, match.group_name, webData)
              await saveMatchStats(match.match_id, match.home_team, match.away_team, webData, webData.minute)
              await log('MATCH_STARTED', match.match_id, `${match.home_team} vs ${match.away_team} arrancó`)
            }
          }
        }
      }

      await log('NO_LIVE_MATCHES', null, 'No hay partidos en vivo ahora')
    }

  } catch (e) {
    console.error('Error general:', e.message)
    await log('ERROR', null, e.message)
  }

  console.log('✅ EDGEIQ Tracker completado')
}

main()
