import { FeatureCatalog } from '@/components/feature-catalog';
import { PageHeader } from '@/components/page-header';

export default function FeaturesPage() {
    return (
        <div className='space-y-8'>
            <PageHeader
                title='Fonctionnalités'
                description='Gérez les clés et la disponibilité globale des modules. Les plans et leurs droits sont définis chez le fournisseur externe.'
            />
            <FeatureCatalog />
        </div>
    );
}
