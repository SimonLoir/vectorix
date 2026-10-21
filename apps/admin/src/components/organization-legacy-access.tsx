'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@repo/ui/badge';
import { Button } from '@repo/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@repo/ui/dialog';
import { useORPC } from '@/hooks/use-orpc';

/** Explicit superadmin-only exemption; never creates or cancels a remote financial obligation. */
export function OrganizationLegacyAccess({
    organizationId,
    enabled,
}: {
    readonly organizationId: string;
    readonly enabled: boolean;
}) {
    const { orpc } = useORPC();
    const queryClient = useQueryClient();
    const [confirmationOpen, setConfirmationOpen] = useState(false);
    const mutation = useMutation(
        orpc.superadmin.organizations.setLegacyAccess.mutationOptions({
            onSuccess: async () => {
                setConfirmationOpen(false);
                await Promise.all([
                    queryClient.invalidateQueries({
                        queryKey: orpc.superadmin.organizations.key(),
                    }),
                    queryClient.invalidateQueries({
                        queryKey: orpc.superadmin.dashboard.key(),
                    }),
                ]);
                toast.success('Mode d’accès Vectorix mis à jour');
            },
        })
    );
    return (
        <Card className='admin-panel rounded-2xl shadow-none'>
            <CardHeader className='space-y-3'>
                <CardTitle className='flex items-center gap-2 text-base'>
                    <ShieldCheck className='h-4 w-4 text-indigo-300' />
                    Accès Vectorix
                </CardTitle>
                <div>
                    <Badge variant={enabled ? 'default' : 'secondary'}>
                        {enabled
                            ? 'Organisation legacy'
                            : 'Fournisseur externe'}
                    </Badge>
                </div>
            </CardHeader>
            <CardContent className='space-y-4 text-sm'>
                <p className='text-slate-400'>
                    {enabled
                        ? 'Cette organisation utilise les fonctionnalités choisies dans l’onglet Fonctionnalités, sans dépendre d’un plan ou de la disponibilité du fournisseur.'
                        : 'Les fonctionnalités sont accordées uniquement par le fournisseur externe. Aucun plan local ni override individuel n’est utilisé.'}
                </p>
                <p className='text-xs text-slate-400'>
                    Le mode legacy est réservé aux exceptions gérées par le
                    superadmin. Les permissions des membres restent inchangées.
                </p>
                <Button
                    variant='outline'
                    onClick={() => {
                        mutation.reset();
                        setConfirmationOpen(true);
                    }}
                >
                    {enabled
                        ? 'Retirer le statut legacy'
                        : 'Marquer comme organisation legacy'}
                </Button>
                <Dialog
                    open={confirmationOpen}
                    onOpenChange={(open) => {
                        if (!mutation.isPending) setConfirmationOpen(open);
                    }}
                >
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>
                                {enabled
                                    ? 'Revenir au fournisseur externe ?'
                                    : 'Accorder l’accès legacy ?'}
                            </DialogTitle>
                            <DialogDescription>
                                {enabled
                                    ? 'Sans droits valides chez le fournisseur externe, cette organisation perdra l’accès aux modules. Vérifiez son abonnement avant de confirmer.'
                                    : 'Cette organisation sera exemptée d’abonnement Vectorix. Choisissez ensuite ses fonctionnalités dans l’onglet Fonctionnalités ; aucune fonctionnalité n’est accordée par défaut.'}
                            </DialogDescription>
                        </DialogHeader>
                        <p className='text-sm'>
                            Ce changement ne résilie ni ne modifie un abonnement
                            distant existant. Les renouvellements, demandes de
                            paiement et factures restent gérés par le
                            fournisseur ; adaptez-les séparément si nécessaire.
                        </p>
                        {mutation.isError && (
                            <p
                                role='alert'
                                className='text-sm text-destructive'
                            >
                                {mutation.error.message}
                            </p>
                        )}
                        <DialogFooter>
                            <Button
                                variant='outline'
                                disabled={mutation.isPending}
                                onClick={() => setConfirmationOpen(false)}
                            >
                                Annuler
                            </Button>
                            <Button
                                disabled={mutation.isPending}
                                onClick={() =>
                                    mutation.mutate({
                                        organizationId,
                                        enabled: !enabled,
                                    })
                                }
                            >
                                {mutation.isPending
                                    ? 'Enregistrement…'
                                    : 'Confirmer'}
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            </CardContent>
        </Card>
    );
}
