import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getSupabaseClient } from '../_shared/supabase-client.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const { category, location } = await req.json();
    if (!category?.trim() || !location?.trim()) {
      return json({ error: 'Informe categoria e localização' }, 400);
    }

    // Verificar se está autenticado (opcional pra free trial)
    const authHeader = req.headers.get('Authorization');
    let userId: string | null = null;

    if (authHeader && authHeader !== `Bearer ${Deno.env.get('SUPABASE_ANON_KEY')}`) {
      const supabaseAuth = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_ANON_KEY')!,
        { global: { headers: { Authorization: authHeader } } },
      );
      const { data: { user } } = await supabaseAuth.auth.getUser();
      if (user) {
        userId = user.id;
        // Verificar buscas restantes
        const db = getSupabaseClient();
        const { data: profile } = await db
          .from('users')
          .select('searches_left')
          .eq('id', userId)
          .single();
        if (!profile || profile.searches_left <= 0) {
          return json({ error: 'Sem buscas restantes', code: 'NO_SEARCHES' }, 402);
        }
      }
    }

    // Chamar Apify
    const APIFY_TOKEN = Deno.env.get('APIFY_TOKEN')!;
    console.log(`[EncontraZap] Buscando "${category}" em "${location}"`);

    const apifyRes = await fetch(
      `https://api.apify.com/v2/acts/compass~crawler-google-places/run-sync-get-dataset-items?token=${APIFY_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          searchStringsArray: [category],
          locationQuery: location,
          maxCrawledPlacesPerSearch: 30, // pegar mais pra compensar filtro de celular
          language: 'pt-BR',
        }),
      },
    );

    if (!apifyRes.ok) {
      const errText = await apifyRes.text();
      console.error('[EncontraZap] Apify error:', errText);
      return json({ error: 'Erro ao buscar leads. Tente novamente.' }, 500);
    }

    const rawResults = await apifyRes.json();

    // Filtrar: só números de celular (provavelmente tem WhatsApp)
    // Celular BR: 11 dígitos (com DDD) e o 5º dígito é 9
    // Ex: 35991326444 → dígitos[0-1]=DDD, dígito[2]=9 → celular ✅
    // Fixo BR: 10 dígitos (com DDD) ou 5º dígito não é 9
    // Ex: 3538512100 → 10 dígitos → fixo ❌
    function isCelular(phone: string): boolean {
      const digits = phone.replace(/\D/g, '');
      // Remove +55 se tiver
      const local = digits.startsWith('55') && digits.length > 11 ? digits.slice(2) : digits;
      // Celular: 11 dígitos, 3º dígito é 9 (após DDD de 2 dígitos)
      return local.length === 11 && local[2] === '9';
    }

    const leads = rawResults
      .filter((r: any) => r.phone && r.phone.trim() && isCelular(r.phone))
      .sort((a: any, b: any) => (b.reviewsCount || 0) - (a.reviewsCount || 0))
      .slice(0, 8)
      .map((r: any) => ({
        name: r.title || r.name || 'Sem nome',
        phone: r.phone?.replace(/\D/g, '') || '',
        rating: r.totalScore || 0,
        reviews: r.reviewsCount || 0,
        address: [r.street, r.city].filter(Boolean).join(', ') || r.address || '',
      }));

    // Se logado: salvar no banco e decrementar buscas
    if (userId) {
      const db = getSupabaseClient();

      // Criar search
      const { data: search, error: searchErr } = await db
        .from('searches')
        .insert({
          user_id: userId,
          category: category.trim(),
          location: location.trim(),
          results_count: leads.length,
        })
        .select('id')
        .single();

      if (searchErr) {
        console.error('[EncontraZap] Search insert error:', searchErr);
      }

      // Inserir leads
      if (search && leads.length > 0) {
        const leadsToInsert = leads.map((l: any) => ({
          search_id: search.id,
          name: l.name,
          phone: l.phone,
          rating: l.rating,
          reviews: l.reviews,
          address: l.address,
        }));
        await db.from('leads').insert(leadsToInsert);
      }

      // Decrementar buscas (lê valor atual e subtrai 1)
      const { data: currentUser } = await db
        .from('users')
        .select('searches_left')
        .eq('id', userId)
        .single();
      if (currentUser) {
        await db
          .from('users')
          .update({ searches_left: Math.max(0, currentUser.searches_left - 1) })
          .eq('id', userId);
      }
    }

    console.log(`[EncontraZap] Retornando ${leads.length} leads`);
    return json({ leads, count: leads.length });
  } catch (err) {
    console.error('[EncontraZap] Error:', err);
    return json({ error: err.message || 'Erro interno' }, 500);
  }
});
