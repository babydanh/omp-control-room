import { useState } from 'react';

import { CompanyClient } from './company/companyClient.js';
import { BoardShell } from './company/components/BoardShell.js';
import { folderPrefsStorage } from './company/folderPrefs.js';
import { useCompanyTransport } from './company/useCompanyTransport.js';
import { ConnectionIndicator } from './components/ConnectionIndicator.js';
import { transport } from './transport/index.js';

function App() {
  // The company client owns every company message and every company command.
  // It is created once and outlives the effects around it.
  const [company] = useState(() => new CompanyClient(transport, folderPrefsStorage()));
  useCompanyTransport(company);

  return (
    <div className="relative h-full w-full overflow-hidden">
      <BoardShell client={company} />
      <ConnectionIndicator />
    </div>
  );
}

export default App;
