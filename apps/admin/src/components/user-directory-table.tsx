import Link from 'next/link';
import { ArrowUpRight, ShieldCheck } from 'lucide-react';
import { Badge } from '@repo/ui/badge';
import { Button } from '@repo/ui/button';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@repo/ui/table';
import type { AdminUser } from './user-types';

/** Account directory with explicit global access labels and links to the selected user. */
export function UserDirectoryTable({
    users,
}: Readonly<{ users: AdminUser[] }>) {
    return (
        <Table>
            <TableHeader>
                <TableRow className='border-white/8 bg-white/[0.025] hover:bg-white/[0.025]'>
                    <TableHead className='h-12 pl-6'>Utilisateur</TableHead>
                    <TableHead>Accès console</TableHead>
                    <TableHead className='hidden md:table-cell'>
                        E-mail
                    </TableHead>
                    <TableHead className='hidden lg:table-cell'>
                        Organisations
                    </TableHead>
                    <TableHead className='pr-6 text-right'>Action</TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                {users.map((user) => (
                    <TableRow
                        key={user.id}
                        className='border-white/8 hover:bg-cyan-400/[0.035]'
                    >
                        <TableCell className='py-4 pl-6'>
                            <Link
                                href={`/users/${encodeURIComponent(user.id)}`}
                                className='block font-semibold text-slate-100 hover:text-cyan-200'
                            >
                                {user.name}
                            </Link>
                            <p className='mt-1 break-all text-xs text-slate-400'>
                                {user.email}
                            </p>
                        </TableCell>
                        <TableCell>
                            {user.isSuperAdmin ? (
                                <Badge
                                    variant='outline'
                                    className='border-cyan-400/20 bg-cyan-400/10 text-cyan-200'
                                >
                                    <ShieldCheck className='h-3 w-3' />{' '}
                                    Superadmin
                                </Badge>
                            ) : (
                                <span className='text-xs text-slate-500'>
                                    Sans accès
                                </span>
                            )}
                        </TableCell>
                        <TableCell className='hidden text-xs text-slate-400 md:table-cell'>
                            {user.emailVerified ? 'Vérifié' : 'Non vérifié'}
                        </TableCell>
                        <TableCell className='hidden text-sm text-slate-400 lg:table-cell'>
                            {user._count.members}
                        </TableCell>
                        <TableCell className='pr-6 text-right'>
                            <Button
                                asChild
                                variant='ghost'
                                size='sm'
                                className='rounded-xl text-slate-400 hover:text-cyan-200'
                            >
                                <Link
                                    href={`/users/${encodeURIComponent(user.id)}`}
                                >
                                    Gérer <ArrowUpRight className='h-4 w-4' />
                                </Link>
                            </Button>
                        </TableCell>
                    </TableRow>
                ))}
                {users.length === 0 ? (
                    <TableRow>
                        <TableCell
                            colSpan={5}
                            className='h-32 text-center text-slate-400'
                        >
                            Aucun utilisateur trouvé.
                        </TableCell>
                    </TableRow>
                ) : null}
            </TableBody>
        </Table>
    );
}
