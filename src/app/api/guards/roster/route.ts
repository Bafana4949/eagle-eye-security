import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const DEFAULT_GUARDS = [
  {
    id: 'e495f1f3-72a0-4231-86fb-617c4624bbe5',
    firstName: 'Sipho',
    lastName: 'Khoza',
    name: 'Sipho Khoza',
    employeeNumber: 'G-101',
    company: 'Aiguille Security',
    siteName: 'Dawie Boerdery - Main Farm',
    phone: '+27 82 111 2222'
  },
  {
    id: '22222222-1111-4231-86fb-617c4624bbe5',
    firstName: 'Petrus',
    lastName: 'Ndlovu',
    name: 'Petrus Ndlovu',
    employeeNumber: 'G-102',
    company: 'Aiguille Security',
    siteName: 'Dawie Boerdery - Main Farm',
    phone: '+27 82 333 4444'
  }
];

export async function GET() {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://zuqcmqrfdousdcjybycr.supabase.co';
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!serviceRoleKey) {
      return NextResponse.json({ guards: DEFAULT_GUARDS });
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // Fetch user IDs with 'guard' role
    const { data: guardRoles } = await supabase
      .from('user_roles')
      .select('user_id')
      .eq('role', 'guard');

    if (!guardRoles || guardRoles.length === 0) {
      return NextResponse.json({ guards: DEFAULT_GUARDS });
    }

    const guardIds = guardRoles.map((r) => r.user_id);

    // Fetch profiles for these guards
    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('id, first_name, last_name, employee_number, phone_number, is_active')
      .in('id', guardIds)
      .eq('is_active', true);

    if (error || !profiles || profiles.length === 0) {
      return NextResponse.json({ guards: DEFAULT_GUARDS });
    }

    const formattedGuards = profiles.map((p) => ({
      id: p.id,
      firstName: p.first_name,
      lastName: p.last_name,
      name: `${p.first_name} ${p.last_name}`,
      employeeNumber: p.employee_number || 'G-101',
      company: 'Aiguille Security',
      siteName: 'Dawie Boerdery - Main Farm',
      phone: p.phone_number || ''
    }));

    return NextResponse.json({ guards: formattedGuards });
  } catch (err) {
    console.warn('API error fetching guards:', err);
    return NextResponse.json({ guards: DEFAULT_GUARDS });
  }
}
