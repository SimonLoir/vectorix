import { FeatureCatalog } from '@/components/feature-catalog';
import { PageHeader } from '@/components/page-header';

export default function FeaturesPage() {
    return (
        <div className='space-y-8'>
            <PageHeader
                titleKey='secondary.pages.featuresTitle'
                descriptionKey='secondary.pages.featuresDescription'
            />
            <FeatureCatalog />
        </div>
    );
}
