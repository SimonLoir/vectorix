import { assertRuntimeConfiguration } from '@repo/config';

// Imported first by the entry point so production stops before any connection opens.
assertRuntimeConfiguration('workers');
