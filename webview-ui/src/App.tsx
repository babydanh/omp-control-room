import { useState } from 'react';

import { CompanyClient } from './company/companyClient.js';
import { BoardShell } from './company/components/BoardShell.js';
import { UsagePage } from './company/components/usage/UsagePage.js';
import { folderPrefsStorage } from './company/folderPrefs.js';
import { useCompanyTransport } from './company/useCompanyTransport.js';
import { useUsageRoute } from './company/useUsageRoute.js';
import { ConnectionIndicator } from './components/ConnectionIndicator.js';
import { transport } from './transport/index.js';

function App() {
  // The company client owns every company message and every company command.
  // It is created once and outlives the effects around it.
  const [company] = useState(() => new CompanyClient(transport, folderPrefsStorage()));
  useCompanyTransport(company);
  // The usage page is a route of its own: the board unmounts while it shows.
  const usageOpen = useUsageRoute();

  return (
    <div className="relative h-full w-full overflow-hidden">
      {usageOpen ? <UsagePage client={company} /> : <BoardShell client={company} />}
      <ConnectionIndicator />
    </div>
  );
}

export default App;
