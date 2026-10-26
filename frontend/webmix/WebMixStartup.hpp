/******************************************************************************
    Copyright (C) 2025 WebMIX contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 2 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.
******************************************************************************/

#pragma once

#include <QString>

class QWidget;

/* WebMIX: the startup chooser for web mode.
 *
 * Web mode binds the interface to one address and port, and those used to be
 * command-line-only. This asks once, from the addresses the machine actually
 * has, and can remember the answer so unattended launches never prompt again. */
namespace WebMixStartup {

/*! Ask which address and port the web interface should listen on.
 *
 * \param parent   window to centre on and stay above (may be null)
 * \param host     in: the address to preselect; out: the chosen one
 * \param port     in: the port to preselect; out: the chosen one
 * \param remember out: true when the answer should be saved as the default
 * \return false when the user cancelled the launch
 */
bool AskEndpoint(QWidget *parent, QString &host, quint16 &port, bool &remember);

/* Starting with the computer (Settings > General in the web interface): an
 * XDG autostart entry on Linux and the BSDs, the per-user Run key on Windows.
 * The entry runs this executable with --autostart (start from its own
 * directory) and the address and port to serve on, so it never asks. */

/*! Whether this system has a sign-in autostart WebMIX knows how to set. */
bool AutostartSupported();

/*! Whether the sign-in entry exists. */
bool AutostartEnabled();

/*! Create the entry (serving on `host`:`port`) or remove it. */
bool SetAutostart(bool enable, const QString &host, quint16 port, QString &error);

} // namespace WebMixStartup
